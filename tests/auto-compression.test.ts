import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import {
    createAutomaticCompressionEventHandler,
    createChatParamsHandler,
    getAssistantContextTokens,
    resolveAutomaticCompressionThreshold,
} from "../lib/auto-compression.ts"
import { DEFAULT_AUTO_COMPRESSION, type PluginConfig } from "../lib/config.ts"
import { SessionStateManager } from "../lib/state/state.ts"

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
})

describe("automatic compression lifecycle", () => {
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
