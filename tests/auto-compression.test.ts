import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
    createAutomaticCompressionEventHandler,
    createChatParamsHandler,
    getAssistantContextTokens,
    resolveAutomaticCompressionThreshold,
} from "../lib/auto-compression.ts"
import { DEFAULT_AUTO_COMPRESSION, type PluginConfig } from "../lib/config.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import {
    getPostCompressionCooldownRemaining,
    resolveEffectiveAutoCompressionPolicy,
} from "../lib/auto-policy.ts"

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
} as any

const config: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "off",
    notificationType: "chat",
    commands: { enabled: true, protectedTools: [] },
    autoCompression: { ...DEFAULT_AUTO_COMPRESSION },
    turnProtection: { enabled: false, turns: 0 },
    protectedFilePatterns: [],
    tools: {
        settings: { protectedTools: [] },
        compress: { permission: "allow", showCompression: false },
        compress_map: { permission: "allow" },
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

const userMessage = (id: string, sessionID: string, text: string) => ({
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

const assistantMessage = (id: string, sessionID: string, text: string) => ({
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
    parts: [
        { type: "step-start" },
        { type: "text", text },
    ],
})

describe("automatic compression thresholds", () => {
    it("defaults the absolute initiation threshold to 300,000 tokens", () => {
        assert.equal(DEFAULT_AUTO_COMPRESSION.tokenThreshold, 300_000)
        assert.equal(DEFAULT_AUTO_COMPRESSION.contextWindowRatio, 0.9)
        assert.equal(DEFAULT_AUTO_COMPRESSION.protectedTurns, 3)
    })

    it("uses the earlier of 90% of the context window and the absolute threshold", () => {
        const small = resolveAutomaticCompressionThreshold(180_000, DEFAULT_AUTO_COMPRESSION, 200_000)
        const large = resolveAutomaticCompressionThreshold(300_000, DEFAULT_AUTO_COMPRESSION, 1_000_000)

        assert.equal(small.thresholdTokens, 180_000)
        assert.equal(small.reason, "context-window-ratio")
        assert.equal(large.thresholdTokens, 300_000)
        assert.equal(large.reason, "absolute-token-threshold")
    })

    it("uses provider totals when available and otherwise sums cache and generated tokens", () => {
        assert.equal(getAssistantContextTokens({ total: 123_456, input: 1 }), 123_456)
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
        const toolResponse = {
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

        assert.equal(getPostCompressionCooldownRemaining(state, messages as any), 1)
        messages.push(assistantMessage("normal-3", sessionId, "Third normal response"))
        assert.equal(getPostCompressionCooldownRemaining(state, messages as any), 0)
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

        assert.equal(getPostCompressionCooldownRemaining(state, messages as any), 0)
    })

    it("suppresses the next three responses above threshold and allows the fourth", async () => {
        const sessionId = `session-auto-cooldown-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const messages: any[] = [
            userMessage("old-user", sessionId, "Old work"),
            assistantMessage("old-assistant", sessionId, "Old result"),
            assistantMessage("compress-anchor", sessionId, "Compression completed"),
        ]
        const promptCalls: any[] = []
        const client = {
            _client: {},
            session: {
                get: async () => ({ data: {} }),
                messages: async () => ({ data: messages }),
                promptAsync: async (input: any) => {
                    promptCalls.push(input)
                    return { data: undefined }
                },
            },
        }
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.compressionCooldownAfterMessageId = "compress-anchor"
        const cooldownConfig: PluginConfig = {
            ...config,
            autoCompression: {
                ...config.autoCompression,
                tokenThreshold: 100,
                protectedTurns: 0,
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
            await handler({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            ...message.info,
                            tokens: { total: 1_000 },
                        },
                    },
                },
            } as any)
        }

        try {
            await complete("response-1")
            await complete("response-2")
            await complete("response-3")
            assert.equal(promptCalls.length, 0)

            await complete("response-4")
            assert.equal(promptCalls.length, 1)
            assert.equal(state.managementTurns[0].triggeredByMessageId, "response-4")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("uses transcript recency while session auto is off and ignores duplicate completion delivery", async () => {
        const sessionId = `session-auto-cooldown-off-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const messages: any[] = [assistantMessage("compress-anchor", sessionId, "Compression")]
        let promptCalls = 0
        const client = {
            _client: {},
            session: {
                get: async () => ({ data: {} }),
                messages: async () => ({ data: messages }),
                promptAsync: async () => {
                    promptCalls++
                    return { data: undefined }
                },
            },
        }
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
                protectedTurns: 0,
            },
        }
        const handler = createAutomaticCompressionEventHandler(
            client,
            stateManager,
            logger,
            cooldownConfig,
        )
        const eventFor = (message: any) => ({
            event: {
                type: "message.updated",
                properties: { info: { ...message.info, tokens: { total: 1_000 } } },
            },
        })

        try {
            const first = assistantMessage("response-1", sessionId, "One")
            messages.push(userMessage("user-1", sessionId, "One"), first)
            await handler(eventFor(first) as any)
            await handler(eventFor(first) as any)
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
            await handler(eventFor(fourth) as any)
            assert.equal(promptCalls, 1)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })
})

describe("automatic compression lifecycle", () => {
    it("skips transcript work when global policy, permission, or the loaded effective threshold makes it unnecessary", async () => {
        const sessionId = `session-auto-fast-path-${Date.now()}-${Math.random().toString(36).slice(2)}`
        let messageReads = 0
        let sessionReads = 0
        const client = {
            session: {
                get: async () => {
                    sessionReads++
                    return { data: {} }
                },
                messages: async () => {
                    messageReads++
                    return { data: [] }
                },
            },
        }
        const event = {
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "fast-path-response",
                        sessionID: sessionId,
                        role: "assistant",
                        time: { completed: Date.now() },
                        tokens: { total: 499 },
                    },
                },
            },
        }

        const globallyDisabled = {
            ...config,
            autoCompression: { ...config.autoCompression, enabled: false },
        }
        await createAutomaticCompressionEventHandler(
            client,
            new SessionStateManager(),
            logger,
            globallyDisabled,
        )(event as any)

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
        )(event as any)

        const mapToolDenied = {
            ...config,
            tools: {
                ...config.tools,
                compress_map: { ...config.tools.compress_map, permission: "deny" as const },
            },
        }
        await createAutomaticCompressionEventHandler(
            client,
            new SessionStateManager(),
            logger,
            mapToolDenied,
        )(event as any)

        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.persistenceSynchronized = true
        state.autoCompressionTokenThresholdOverride = 500
        await createAutomaticCompressionEventHandler(client, stateManager, logger, config)(
            event as any,
        )

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
        const client = {
            _client: {},
            session: {
                get: async () => ({ data: {} }),
                messages: async () => {
                    messageReads++
                    return { data: messages }
                },
                promptAsync: async () => {
                    promptCalls++
                },
            },
        }
        const stateManager = new SessionStateManager()
        const handler = createAutomaticCompressionEventHandler(client, stateManager, logger, {
            ...config,
            autoCompression: { ...config.autoCompression, tokenThreshold: 100 },
        })
        const event = {
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        ...messages[1].info,
                        tokens: { total: 1_000 },
                    },
                },
            },
        }

        try {
            await handler(event as any)
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
            await handler(event as any)
            await handler(event as any)

            assert.equal(promptCalls, 0)
            assert.equal(messageReads, 2)
            assert.equal(stateManager.get(sessionId).persistenceSynchronized, true)
            assert.equal(stateManager.get(sessionId).autoCompressionEnabledOverride, false)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("injects one asynchronous management turn with a protected tail and continuation guidance", async () => {
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
        const promptCalls: any[] = []
        const client = {
            _client: {},
            session: {
                get: async () => ({ data: {} }),
                messages: async () => ({ data: messages }),
                promptAsync: async (input: any) => {
                    promptCalls.push(input)
                    return { data: undefined }
                },
            },
        }
        const stateManager = new SessionStateManager()

        try {
            await createChatParamsHandler(stateManager)({
                sessionID: sessionId,
                model: {
                    id: "gpt-test",
                    providerID: "openai",
                    limit: { context: 1_000_000 },
                },
            })

            const handler = createAutomaticCompressionEventHandler(
                client,
                stateManager,
                logger,
                config,
            )
            const event = {
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            ...messages[7].info,
                            tokens: {
                                input: 10_000,
                                output: 1_000,
                                reasoning: 0,
                                cache: { read: 294_000, write: 0 },
                            },
                        },
                    },
                },
            }

            await handler(event as any)
            await handler(event as any)

            assert.equal(promptCalls.length, 1)
            const body = promptCalls[0].body
            const payload = body.parts.map((part: any) => part.text).join("\n\n")
            assert.match(payload, /AUTOMATIC CONTEXT COMPRESSION REQUIRED/)
            assert.match(payload, /305,000 tokens/)
            assert.match(payload, /300,000 tokens/)
            assert.match(payload, /protected active tail/)
            assert.match(payload, /immediately continue the original task/i)
            assert.match(payload, /Call `compress_map` first/)
            assert.doesNotMatch(payload, /<compress-context-map>/)

            const state = stateManager.get(sessionId)
            assert.equal(state.managementTurns.length, 1)
            assert.equal(state.managementTurns[0].source, "automatic")
            assert.equal(state.managementTurns[0].triggeredByMessageId, "m8")
            assert.deepEqual(state.managementTurns[0].protectedMessageIds, ["m4", "m5", "m6", "m7", "m8"])
            assert.equal(state.managementTurns[0].thresholdTokens, 300_000)
            assert.equal(state.autoCompressionStarting, false)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("does not initiate below the effective threshold", async () => {
        const sessionId = `session-auto-below-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const stateManager = new SessionStateManager()
        let promptCalls = 0
        const client = {
            _client: {},
            session: {
                promptAsync: async () => {
                    promptCalls++
                },
            },
        }
        const handler = createAutomaticCompressionEventHandler(client, stateManager, logger, config)

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "m1",
                        sessionID: sessionId,
                        role: "assistant",
                        time: { completed: Date.now() },
                        tokens: {
                            input: 20_000,
                            output: 1_000,
                            cache: { read: 100_000, write: 0 },
                        },
                    },
                },
            },
        } as any)

        assert.equal(promptCalls, 0)
    })
})
