import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
    createAutomaticCompressionEventHandler,
    getAssistantContextTokens,
    resolveAutomaticCompressionThreshold,
} from "../lib/auto-compression.ts"
import { DEFAULT_AUTO_COMPRESSION, type PluginConfig } from "../lib/config.ts"
import { Logger } from "../lib/logger.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import { saveSessionState } from "../lib/state/persistence.ts"
import type { WithParts } from "../lib/state/types.ts"
import {
    getPostCompressionCooldownRemaining,
    resolveEffectiveAutoCompressionPolicy,
} from "../lib/auto-policy.ts"
import { fakeClient, type PromptInput } from "./helpers.ts"

const logger = new Logger({ daily: false, context: false })

const config: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "off",
    protectedTurns: 3,
    commands: { enabled: true },
    autoCompression: { ...DEFAULT_AUTO_COMPRESSION },
    tools: {
        compress: { permission: "allow", showCompression: false },
    },
}

const getSessionFilePath = (sessionId: string) =>
    join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "compress",
        `${sessionId}.json`,
    )

const cleanupSessionFile = async (sessionId: string) => {
    const filePath = getSessionFilePath(sessionId)
    if (existsSync(filePath)) await rm(filePath)
}

const userMessage = (id: string, sessionID: string, text: string): WithParts => ({
    info: {
        id,
        sessionID,
        role: "user" as const,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
})

const assistantMessage = (id: string, sessionID: string, text: string): WithParts => ({
    info: {
        id,
        sessionID,
        role: "assistant" as const,
        agent: "build",
        providerID: "openai",
        modelID: "gpt-test",
        time: { created: Date.now(), completed: Date.now() },
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ type: "step-start" }, { type: "text", text }],
})

const usage = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

const stepEnded = (
    sessionID: string,
    assistantMessageID: string,
    tokens: ReturnType<typeof usage>,
) => ({ type: "session.step.ended", data: { sessionID, assistantMessageID, tokens } })

describe("automatic compression thresholds", () => {
    it("defaults the absolute initiation threshold to 432,000 tokens", () => {
        assert.equal(DEFAULT_AUTO_COMPRESSION.tokenThreshold, 432_000)
        assert.equal(DEFAULT_AUTO_COMPRESSION.contextWindowRatio, 0.9)
        assert.equal(config.protectedTurns, 3)
    })

    it("uses the earlier of 90% of the context window and the absolute threshold", () => {
        const small = resolveAutomaticCompressionThreshold(
            180_000,
            DEFAULT_AUTO_COMPRESSION,
            200_000,
        )
        const large = resolveAutomaticCompressionThreshold(
            432_000,
            DEFAULT_AUTO_COMPRESSION,
            1_000_000,
        )

        assert.equal(small.thresholdTokens, 180_000)
        assert.equal(small.reason, "context-window-ratio")
        assert.equal(large.thresholdTokens, 432_000)
        assert.equal(large.reason, "absolute-token-threshold")
    })

    it("sums input, generated, and cache tokens", () => {
        assert.equal(
            getAssistantContextTokens({
                input: 100,
                output: 20,
                reasoning: 5,
                cache: { read: 70, write: 10 },
            }),
            205,
        )
    })

    it("resolves session overrides without coupling the independent triggers", () => {
        const stateManager = new SessionStateManager()
        const state = stateManager.get("effective-policy")
        state.autoCompressionEnabledOverride = false
        state.autoCompressionTokenThresholdOverride = 500_000
        state.autoCompressionContextWindowRatioOverride = 0.5

        const off = resolveEffectiveAutoCompressionPolicy(config.autoCompression, state)
        assert.equal(off.enabled, false)
        assert.equal(off.tokenThreshold, 500_000)
        assert.equal(off.contextWindowRatio, 0.5)

        state.autoCompressionEnabledOverride = true
        const on = resolveEffectiveAutoCompressionPolicy(config.autoCompression, state)
        const threshold = resolveAutomaticCompressionThreshold(250_000, on, 400_000)
        assert.equal(on.enabled, true)
        assert.equal(threshold.thresholdTokens, 200_000)
        assert.equal(threshold.reason, "context-window-ratio")
    })
})

describe("post-compression cooldown", () => {
    it("counts unique completed primary responses and excludes management spans", () => {
        const sessionId = "cooldown-counting"
        const state = new SessionStateManager().get(sessionId)
        state.initialized = true
        state.compressionCooldownAfterMessageId = "compress-anchor"
        state.managementTurns = [{ triggerMessageId: "manage-trigger" }]
        const duplicate = assistantMessage("normal-1", sessionId, "First normal response")
        const toolResponse: WithParts = {
            ...assistantMessage("normal-2", sessionId, "Second normal response"),
            parts: [
                {
                    type: "tool",
                    tool: "compress",
                    callID: "call-normal-2",
                    state: { status: "completed", input: {}, output: "done" },
                },
            ],
        }
        const messages = [
            assistantMessage("compress-anchor", sessionId, "Compression call"),
            userMessage("manage-trigger", sessionId, "Manage context"),
            assistantMessage("manage-assistant", sessionId, "Inside management"),
            userMessage("normal-user", sessionId, "Continue"),
            duplicate,
            duplicate,
            toolResponse,
        ]

        assert.equal(getPostCompressionCooldownRemaining(state, messages), 1)
        messages.push(assistantMessage("normal-3", sessionId, "Third normal response"))
        assert.equal(getPostCompressionCooldownRemaining(state, messages), 0)
    })

    it("counts assistant responses after a completed management turn before the next user message", () => {
        const sessionId = "cooldown-completed-management-boundary"
        const state = new SessionStateManager().get(sessionId)
        state.initialized = true
        state.compressionCooldownAfterMessageId = "compress-anchor"
        state.managementTurns = [
            {
                triggerMessageId: "manage-trigger",
                completedAt: new Date().toISOString(),
                completedMessageId: "compress-anchor",
            },
        ]
        const messages = [
            userMessage("manage-trigger", sessionId, "Manage context"),
            assistantMessage("compress-anchor", sessionId, "Compression completed"),
            assistantMessage("continuation-1", sessionId, "Continued original task"),
            assistantMessage("continuation-2", sessionId, "More task progress"),
            assistantMessage("continuation-3", sessionId, "Finished task progress"),
        ]

        assert.equal(getPostCompressionCooldownRemaining(state, messages), 0)
    })

    it("preserves the three-response cooldown for a reloaded subagent and allows the fourth", async () => {
        const sessionId = `session-auto-cooldown-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const messages = [
            userMessage("old-user", sessionId, "Old work"),
            assistantMessage("old-assistant", sessionId, "Old result"),
            assistantMessage("compress-anchor", sessionId, "Compression completed"),
        ]
        const promptCalls: PromptInput[] = []
        const client = fakeClient({
            context: async () => messages,
            prompt: (input) => promptCalls.push(input),
        })
        const initialState = new SessionStateManager().get(sessionId)
        initialState.compressionCooldownAfterMessageId = "compress-anchor"
        await saveSessionState(initialState, logger)
        const stateManager = new SessionStateManager()
        const cooldownConfig: PluginConfig = {
            ...config,
            autoCompression: {
                ...config.autoCompression,
                tokenThreshold: 100,
            },
        }
        const handler = createAutomaticCompressionEventHandler(
            client,
            stateManager,
            logger,
            cooldownConfig,
        )

        const complete = async (id: string) => {
            const message = assistantMessage(id, sessionId, id)
            messages.push(userMessage(`user-${id}`, sessionId, `Request ${id}`), message)
            await handler(stepEnded(sessionId, message.info.id, usage(1_000)))
        }

        try {
            await complete("response-1")
            await complete("response-2")
            await complete("response-3")
            assert.equal(promptCalls.length, 0)

            await complete("response-4")
            assert.equal(promptCalls.length, 1)
            assert.equal(
                stateManager.get(sessionId).managementTurns[0].triggeredByMessageId,
                "response-4",
            )
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("uses transcript recency while session auto is off and ignores duplicate completion delivery", async () => {
        const sessionId = `session-auto-cooldown-off-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const messages = [assistantMessage("compress-anchor", sessionId, "Compression")]
        let promptCalls = 0
        const client = fakeClient({
            context: async () => messages,
            prompt: () => {
                promptCalls++
            },
        })
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.compressionCooldownAfterMessageId = "compress-anchor"
        state.autoCompressionEnabledOverride = false
        const cooldownConfig: PluginConfig = {
            ...config,
            autoCompression: {
                ...config.autoCompression,
                tokenThreshold: 100,
            },
        }
        const handler = createAutomaticCompressionEventHandler(
            client,
            stateManager,
            logger,
            cooldownConfig,
        )
        const eventFor = (message: WithParts) => stepEnded(sessionId, message.info.id, usage(1_000))

        try {
            const first = assistantMessage("response-1", sessionId, "One")
            messages.push(userMessage("user-1", sessionId, "One"), first)
            await handler(eventFor(first))
            await handler(eventFor(first))
            assert.equal(getPostCompressionCooldownRemaining(state, messages), 2)

            messages.push(
                userMessage("user-2", sessionId, "Two"),
                assistantMessage("response-2", sessionId, "Two"),
                userMessage("user-3", sessionId, "Three"),
                assistantMessage("response-3", sessionId, "Three"),
            )
            assert.equal(getPostCompressionCooldownRemaining(state, messages), 0)
            assert.equal(promptCalls, 0)

            state.autoCompressionEnabledOverride = true
            const fourth = assistantMessage("response-4", sessionId, "Four")
            messages.push(userMessage("user-4", sessionId, "Four"), fourth)
            await handler(eventFor(fourth))
            assert.equal(promptCalls, 1)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })
})

describe("automatic compression lifecycle", () => {
    it("surfaces automatic-start failures through immediate no-model feedback", async () => {
        const sessionId = `session-auto-v2-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const notifications: unknown[] = []
        const client = fakeClient({
            context: async () => {
                throw new Error("offline")
            },
            synthetic: (input) => notifications.push(input),
        })
        await createAutomaticCompressionEventHandler(
            client,
            new SessionStateManager(),
            logger,
            config,
        )(stepEnded(sessionId, "v2-failed-start", usage(400_000)))

        assert.deepEqual(notifications, [
            {
                sessionID: sessionId,
                id: undefined,
                text: "Could not start automatic compression: offline",
                description: "Could not start automatic compression: offline",
                metadata: { "opencode.context-compress.ignored": true },
                resume: false,
            },
        ])
    })

    it("skips transcript work when global policy, permission, or the loaded effective threshold makes it unnecessary", async () => {
        const sessionId = `session-auto-fast-path-${Date.now()}-${Math.random().toString(36).slice(2)}`
        let messageReads = 0
        let sessionReads = 0
        const base = fakeClient({
            context: async () => {
                messageReads++
                return []
            },
        })
        const client = {
            ...base,
            session: {
                ...base.session,
                get: async () => {
                    sessionReads++
                    return {}
                },
            },
        }
        const event = stepEnded(sessionId, "fast-path-response", usage(499))

        const globallyDisabled = {
            ...config,
            autoCompression: { ...config.autoCompression, enabled: false },
        }
        await createAutomaticCompressionEventHandler(
            client,
            new SessionStateManager(),
            logger,
            globallyDisabled,
        )(event)

        const toolDenied = {
            ...config,
            tools: {
                ...config.tools,
                compress: { ...config.tools.compress, permission: "deny" as const },
            },
        }
        await createAutomaticCompressionEventHandler(
            client,
            new SessionStateManager(),
            logger,
            toolDenied,
        )(event)

        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.persistenceSynchronized = true
        state.autoCompressionTokenThresholdOverride = 500
        await createAutomaticCompressionEventHandler(client, stateManager, logger, config)(event)

        assert.equal(messageReads, 0)
        assert.equal(sessionReads, 0)
    })

    it("does not use fallback auto policy when persisted session state cannot be loaded", async () => {
        const sessionId = `session-auto-policy-load-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const filePath = getSessionFilePath(sessionId)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, "{invalid-json", "utf8")
        const messages = [
            userMessage("load-fail-user", sessionId, "Old objective"),
            assistantMessage("load-fail-assistant", sessionId, "Old result"),
        ]
        let messageReads = 0
        let promptCalls = 0
        const client = fakeClient({
            context: async () => {
                messageReads++
                return messages
            },
            prompt: () => {
                promptCalls++
            },
        })
        const stateManager = new SessionStateManager()
        const handler = createAutomaticCompressionEventHandler(client, stateManager, logger, {
            ...config,
            autoCompression: { ...config.autoCompression, tokenThreshold: 100 },
        })
        const event = stepEnded(sessionId, messages[1].info.id, usage(1_000))

        try {
            await handler(event)
            assert.equal(promptCalls, 0)
            assert.equal(messageReads, 1)
            assert.equal(stateManager.get(sessionId).persistenceSynchronized, false)

            await writeFile(
                filePath,
                JSON.stringify({
                    compressed: { toolIds: [], messageIds: [] },
                    compressSummaries: [],
                    managementTurns: [],
                    stats: { compressTokenCounter: 0, totalCompressTokens: 0 },
                    autoCompressionEnabledOverride: false,
                    lastUpdated: new Date().toISOString(),
                }),
                "utf8",
            )
            await handler(event)
            await handler(event)

            assert.equal(promptCalls, 0)
            assert.equal(messageReads, 2)
            assert.equal(stateManager.get(sessionId).persistenceSynchronized, true)
            assert.equal(stateManager.get(sessionId).autoCompressionEnabledOverride, false)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("injects one subagent management turn with a protected tail and continuation guidance", async () => {
        const sessionId = `session-auto-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        const messages = [
            userMessage("m1", sessionId, "Old objective"),
            assistantMessage("m2", sessionId, "Old work"),
            userMessage("m3", sessionId, "Middle objective"),
            assistantMessage("m4", sessionId, "Middle work"),
            userMessage("m5", sessionId, "Current objective"),
            assistantMessage("m6", sessionId, "Current work"),
            userMessage("m7", sessionId, "Keep going"),
            assistantMessage("m8", sessionId, "Latest work"),
        ]
        const promptCalls: PromptInput[] = []
        const client = fakeClient({
            context: async () => messages,
            prompt: (input) => promptCalls.push(input),
        })
        const stateManager = new SessionStateManager()

        try {
            stateManager.get(sessionId).modelContext = {
                providerId: "openai",
                modelId: "gpt-test",
                contextLimit: 1_000_000,
            }

            const handler = createAutomaticCompressionEventHandler(
                client,
                stateManager,
                logger,
                config,
            )
            const event = stepEnded(sessionId, messages[7].info.id, {
                input: 10_000,
                output: 1_000,
                reasoning: 0,
                cache: { read: 439_000, write: 0 },
            })

            await handler({
                type: "session.step.started",
                data: {
                    sessionID: sessionId,
                    assistantMessageID: messages[7].info.id,
                    agent: "build",
                    model: { providerID: "openai", id: "gpt-test" },
                },
            })
            await handler(event)
            await handler(event)

            assert.equal(promptCalls.length, 1)
            const payload = promptCalls[0].text
            assert.match(payload, /AUTOMATIC CONTEXT COMPRESSION DUE/)
            assert.match(payload, /450,000 tokens/)
            assert.match(payload, /432,000 tokens/)
            assert.match(payload, /the newest configured execution steps remain verbatim/)
            assert.match(payload, /this is not a task-status transition/i)
            assert.match(payload, /continue immediately only when work was genuinely active/i)
            assert.match(
                payload,
                /Preserve completed or awaiting-user status instead of reopening work or duplicating a final response/i,
            )
            assert.match(payload, /call `compress` once/i)
            assert.doesNotMatch(payload, /compress_map|context-map/i)

            const state = stateManager.get(sessionId)
            assert.equal(state.managementTurns.length, 1)
            assert.equal(state.managementTurns[0].source, "automatic")
            assert.equal(state.managementTurns[0].triggeredByMessageId, "m8")
            assert.equal(state.managementTurns[0].protectedMessageIds, undefined)
            assert.equal(state.managementTurns[0].thresholdTokens, 432_000)
            assert.equal(state.autoCompressionStarting, false)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("does not re-inject a reminder while an automatic management turn remains open", async () => {
        const sessionId = `session-auto-subagent-active-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const latest = assistantMessage("latest", sessionId, "Large completed turn")
        const messages = [
            userMessage("user", sessionId, "Continue child work"),
            latest,
            userMessage("manage-trigger", sessionId, "Automatic compression"),
        ]
        const initialState = new SessionStateManager().get(sessionId)
        initialState.managementTurns = [
            {
                triggerMessageId: "manage-trigger",
                source: "automatic",
                triggeredByMessageId: latest.info.id,
            },
        ]
        await saveSessionState(initialState, logger)
        let promptCalls = 0
        const client = fakeClient({
            context: async () => messages,
            prompt: () => {
                promptCalls++
            },
        })

        try {
            const stateManager = new SessionStateManager()
            const handler = createAutomaticCompressionEventHandler(
                client,
                stateManager,
                logger,
                config,
            )
            const event = stepEnded(sessionId, latest.info.id, usage(450_000))
            await handler(event)
            await handler(event)

            const later = assistantMessage("later", sessionId, "Finished the current logical block")
            messages.push(later)
            await handler(stepEnded(sessionId, later.info.id, usage(410_000)))

            assert.equal(promptCalls, 0)
            assert.equal(stateManager.get(sessionId).managementTurns.length, 1)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("does not start subagent management when the protected tail covers all history", async () => {
        const sessionId = `session-auto-subagent-protected-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const latest = assistantMessage("latest", sessionId, "Only child turn")
        const messages = [userMessage("user", sessionId, "One child request"), latest]
        let promptCalls = 0
        const client = fakeClient({
            context: async () => messages,
            prompt: () => {
                promptCalls++
            },
        })

        try {
            const stateManager = new SessionStateManager()
            const handler = createAutomaticCompressionEventHandler(
                client,
                stateManager,
                logger,
                config,
            )
            await handler(stepEnded(sessionId, latest.info.id, usage(400_000)))

            assert.equal(promptCalls, 0)
            assert.equal(stateManager.get(sessionId).managementTurns.length, 0)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("does not initiate below the effective threshold", async () => {
        const sessionId = `session-auto-below-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const stateManager = new SessionStateManager()
        let promptCalls = 0
        const client = fakeClient({
            prompt: () => {
                promptCalls++
            },
        })
        const handler = createAutomaticCompressionEventHandler(client, stateManager, logger, config)

        await handler(
            stepEnded(sessionId, "m1", {
                input: 20_000,
                output: 1_000,
                reasoning: 0,
                cache: { read: 100_000, write: 0 },
            }),
        )

        assert.equal(promptCalls, 0)
    })

    it("keeps ordinary subagent compression working", async () => {
        const sessionId = `session-subagent-auto-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const latest = assistantMessage("latest", sessionId, "Large ordinary turn")
        const messages = [userMessage("user", sessionId, "Ordinary work"), latest]
        const promptCalls: PromptInput[] = []
        const client = fakeClient({
            context: async () => messages,
            prompt: (input) => promptCalls.push(input),
        })

        try {
            const handler = createAutomaticCompressionEventHandler(
                client,
                new SessionStateManager(),
                logger,
                {
                    ...config,
                    protectedTurns: 0,
                },
            )
            await handler(stepEnded(sessionId, latest.info.id, usage(450_000)))
            assert.equal(promptCalls.length, 1)
            assert.match(promptCalls[0].text, /AUTOMATIC CONTEXT COMPRESSION DUE/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })
})
