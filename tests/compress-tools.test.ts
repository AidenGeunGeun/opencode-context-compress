import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { PluginConfig } from "../lib/config.ts"
import { applyCompressTransforms } from "../lib/messages/compress-transform.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import { createCompressMapTool } from "../lib/tools/compress-map.ts"
import { createCompressTool } from "../lib/tools/compress.ts"

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
    commands: {
        enabled: true,
        protectedTools: [],
    },
    turnProtection: {
        enabled: false,
        turns: 0,
    },
    protectedFilePatterns: [],
    tools: {
        settings: {
            protectedTools: [],
        },
        compress: {
            permission: "allow",
            showCompression: false,
        },
        compress_map: {
            permission: "allow",
        },
    },
}

const textMessage = (id: string, sessionID: string, text: string, role: "user" | "assistant" = "user") => ({
    info: {
        id,
        role,
        sessionID,
        agent: "agent-test",
        model: {
            providerID: "openai",
            modelID: "gpt-5.4",
        },
        time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
})

const toolMessage = (
    id: string,
    sessionID: string,
    tool: string,
    output: string,
    callID: string = `call-${id}`,
) => ({
    info: {
        id,
        role: "assistant" as const,
        sessionID,
        agent: "agent-test",
        model: {
            providerID: "openai",
            modelID: "gpt-5.4",
        },
        time: { created: Date.now() },
    },
    parts: [
        {
            type: "tool",
            tool,
            callID,
            state: {
                status: "completed",
                input: {},
                output,
            },
        },
    ],
})

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
    if (existsSync(filePath)) {
        await rm(filePath)
    }
}

const createToolContext = (sessionID: string, callID: string) => ({
    sessionID,
    messageID: `message-${callID}`,
    agent: "agent-test",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    callID,
})

describe("compression management tools", () => {
    it("compress_map returns the current map shape and marks its output for stripping", async () => {
        const sessionId = `session-compress-map-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Phase one request"),
                textMessage("m2", sessionId, "Phase one result", "assistant"),
                textMessage("m3", sessionId, "Phase two request"),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true

            const client = {
                session: {
                    get: async () => ({ data: {} }),
                    messages: async () => ({ data: rawMessages }),
                },
            }

            const tool = createCompressMapTool({
                client,
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            const output = await tool.execute({} as any, createToolContext(sessionId, "call-map-1") as any)

            assert.match(output, /<compress-context-map>/)
            assert.match(output, /\[1\] user:/)
            assert.match(output, /Total: 3 messages \+ 0 blocks/)
            assert.doesNotMatch(output, /Active:/)
            assert.equal(state.compressed.toolIds.has("call-map-1"), true)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("omits prior management tool chatter from refreshed map snapshots", async () => {
        const sessionId = `session-compress-map-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Phase one request"),
                toolMessage(
                    "m2",
                    sessionId,
                    "compress_map",
                    "<compress-context-map>stale management map</compress-context-map>",
                    "call-old-map",
                ),
                textMessage("m3", sessionId, "Phase two request"),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true
            state.compressed.toolIds = new Set(["call-old-map"])

            const client = {
                session: {
                    get: async () => ({ data: {} }),
                    messages: async () => ({ data: rawMessages }),
                },
            }

            const tool = createCompressMapTool({
                client,
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            const output = await tool.execute({} as any, createToolContext(sessionId, "call-map-2") as any)

            assert.doesNotMatch(output, /stale management map/)
            assert.doesNotMatch(output, /assistant: 1 tool calls \(compress_map\)/)
            assert.match(output, /Total: 2 messages \+ 0 blocks/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("supports iterative compress calls within one turn and returns updated maps", async () => {
        const sessionId = `session-compress-iterative-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Older phase request"),
                textMessage("m2", sessionId, "Older phase result", "assistant"),
                textMessage("m3", sessionId, "Recent phase request"),
                textMessage("m4", sessionId, "Recent phase result", "assistant"),
                textMessage("m5", sessionId, "Current active tail"),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true

            const client = {
                session: {
                    get: async () => ({ data: {} }),
                    messages: async () => ({ data: rawMessages }),
                },
            }

            const tool = createCompressTool({
                client,
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            const firstOutput = await tool.execute(
                {
                    ranges: [
                        {
                            from: 1,
                            to: 2,
                            topic: "Older Phase",
                            summary: "Terse summary for the older completed phase.",
                        },
                    ],
                },
                createToolContext(sessionId, "call-compress-1") as any,
            )

            assert.match(firstOutput, /^Compressed 1 ranges/)
            assert.match(firstOutput, /<compress-context-map>/)
            assert.match(firstOutput, /\[b0\] \[compressed\] "Older Phase"/)

            const secondOutput = await tool.execute(
                {
                    ranges: [
                        {
                            from: 1,
                            to: 2,
                            topic: "Recent Phase",
                            summary: "Higher-fidelity summary for the more recent completed phase.",
                        },
                    ],
                },
                createToolContext(sessionId, "call-compress-2") as any,
            )

            assert.match(secondOutput, /^Compressed 1 ranges/)
            assert.match(secondOutput, /\[b0\] \[compressed\] "Older Phase"/)
            assert.match(secondOutput, /\[b1\] \[compressed\] "Recent Phase"/)
            assert.equal(state.compressSummaries.length, 2)
            assert.equal(state.compressed.toolIds.has("call-compress-1"), true)
            assert.equal(state.compressed.toolIds.has("call-compress-2"), true)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("strips compress tool outputs on subsequent turns via compressed tool ids", () => {
        const sessionId = "session-strip-test"
        const manager = new SessionStateManager()
        const state = manager.get(sessionId)
        state.sessionId = sessionId
        state.initialized = true
        state.compressed.toolIds = new Set(["call-map", "call-compress"])

        const messages = [
            textMessage("m1", sessionId, "Manage context, please"),
            toolMessage(
                "m2",
                sessionId,
                "compress_map",
                "<compress-context-map>map</compress-context-map>",
                "call-map",
            ),
            toolMessage(
                "m3",
                sessionId,
                "compress",
                "Compressed 1 ranges\n\n<compress-context-map>updated</compress-context-map>",
                "call-compress",
            ),
        ] as any

        applyCompressTransforms(state, logger, messages)

        const outputs = messages.slice(1).map((message: any) => message.parts[0].state.output)
        assert.deepEqual(outputs, [
            "[Output removed to save context - information superseded or no longer needed]",
            "[Output removed to save context - information superseded or no longer needed]",
        ])
    })
})
