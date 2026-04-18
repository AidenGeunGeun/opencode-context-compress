import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { PluginConfig } from "../lib/config.ts"
import { applyCompressTransforms } from "../lib/messages/compress-transform.ts"
import { buildContextMap } from "../lib/messages/context-map.ts"
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

const createClient = (rawMessages: any[]) => ({
    session: {
        get: async () => ({ data: {} }),
        messages: async () => ({ data: rawMessages }),
    },
})

describe("compression management tools", () => {
    it("compress_map returns the current map shape without marking its output for stripping", async () => {
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

            const client = createClient(rawMessages)

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
            assert.equal(state.compressed.toolIds.has("call-map-1"), false)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("supports iterative compress calls and keeps block numbering stable when recompressing the middle block", async () => {
        const sessionId = `session-compress-iterative-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Phase A request"),
                textMessage("m2", sessionId, "Phase A result", "assistant"),
                textMessage("m3", sessionId, "Phase B request"),
                textMessage("m4", sessionId, "Phase B result", "assistant"),
                textMessage("m5", sessionId, "Phase C request"),
                textMessage("m6", sessionId, "Phase C result", "assistant"),
                textMessage("m7", sessionId, "Current active tail"),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true

            const client = createClient(rawMessages)

            const tool = createCompressTool({
                client,
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            const firstOutput = await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase A",
                    summary: "Terse summary for phase A.",
                },
                createToolContext(sessionId, "call-compress-1") as any,
            )

            assert.match(firstOutput, /^Compressed range/)
            assert.match(firstOutput, /<compress-context-map>/)
            assert.match(firstOutput, /\[b0\] \[compressed\] "Phase A"/)

            const secondOutput = await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase B",
                    summary: "Higher-fidelity summary for phase B.",
                },
                createToolContext(sessionId, "call-compress-2") as any,
            )

            assert.match(secondOutput, /^Compressed range/)
            assert.match(secondOutput, /\[b0\] \[compressed\] "Phase A"/)
            assert.match(secondOutput, /\[b1\] \[compressed\] "Phase B"/)

            const thirdOutput = await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase C",
                    summary: "Steady summary for phase C.",
                },
                createToolContext(sessionId, "call-compress-3") as any,
            )

            assert.match(thirdOutput, /\[b0\] \[compressed\] "Phase A"/)
            assert.match(thirdOutput, /\[b1\] \[compressed\] "Phase B"/)
            assert.match(thirdOutput, /\[b2\] \[compressed\] "Phase C"/)

            const fourthOutput = await tool.execute(
                {
                    from: "b1",
                    to: "b1",
                    topic: "Phase B Updated",
                    summary: "Much terser updated summary for phase B.",
                },
                createToolContext(sessionId, "call-compress-4") as any,
            )

            assert.match(
                fourthOutput,
                /\[b0\] \[compressed\] "Phase A"[\s\S]*\[b1\] \[compressed\] "Phase B Updated"[\s\S]*\[b2\] \[compressed\] "Phase C"/,
            )
            const finalMap = buildContextMap(rawMessages as any, state, logger)

            assert.deepEqual(finalMap.lookup.get("b0"), ["m1", "m2"])
            assert.deepEqual(finalMap.lookup.get("b1"), ["m3", "m4"])
            assert.deepEqual(finalMap.lookup.get("b2"), ["m5", "m6"])
            assert.equal(state.compressSummaries.length, 3)
            assert.equal(state.compressed.toolIds.has("call-compress-1"), false)
            assert.equal(state.compressed.toolIds.has("call-compress-2"), false)
            assert.equal(state.compressed.toolIds.has("call-compress-3"), false)
            assert.equal(state.compressed.toolIds.has("call-compress-4"), false)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("recompresses a block via the next compress call that references it", async () => {
        const sessionId = `session-compress-block-ref-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Older phase request"),
                textMessage("m2", sessionId, "Older phase result", "assistant"),
                textMessage("m3", sessionId, "Current active tail"),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true

            const tool = createCompressTool({
                client: createClient(rawMessages),
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Older Phase",
                    summary: "Detailed older-phase summary.",
                },
                createToolContext(sessionId, "call-compress-a") as any,
            )

            const secondOutput = await tool.execute(
                {
                    from: "b0",
                    to: "b0",
                    topic: "Older Phase Condensed",
                    summary: "Much terser condensed summary.",
                },
                createToolContext(sessionId, "call-compress-b") as any,
            )

            assert.match(secondOutput, /\[b0\] \[compressed\] "Older Phase Condensed"/)
            assert.equal(state.compressSummaries.length, 1)
            assert.equal(state.compressSummaries[0].anchorMessageId, "m1")
            assert.equal(state.compressSummaries[0].summary, "Much terser condensed summary.")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("recompresses a block together with new raw messages and preserves prior block content", async () => {
        const sessionId = `session-compress-mixed-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Phase A request"),
                textMessage("m2", sessionId, "Phase A result", "assistant"),
                textMessage("m3", sessionId, "Phase B request"),
                textMessage("m4", sessionId, "Phase B result", "assistant"),
                textMessage("m5", sessionId, "Current active tail"),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true

            const tool = createCompressTool({
                client: createClient(rawMessages),
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase A",
                    summary: "Stored summary for phase A.",
                },
                createToolContext(sessionId, "call-compress-mixed-1") as any,
            )

            const secondOutput = await tool.execute(
                {
                    from: "b0",
                    to: 2,
                    topic: "Combined A+B",
                    summary: "Fresh summary for the new phase B work.",
                },
                createToolContext(sessionId, "call-compress-mixed-2") as any,
            )

            assert.match(secondOutput, /\[b0\] \[compressed\] "Combined A\+B"/)
            assert.equal(state.compressSummaries.length, 1)
            assert.equal(state.compressSummaries[0].anchorMessageId, "m1")
            assert.match(state.compressSummaries[0].summary, /^\[Preserved context\]/)
            assert.match(state.compressSummaries[0].summary, /Stored summary for phase A\./)
            assert.match(state.compressSummaries[0].summary, /\[New content\]/)
            assert.match(state.compressSummaries[0].summary, /Fresh summary for the new phase B work\./)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("leaves management tool outputs untouched when they were not compressed by range", () => {
        const sessionId = "session-strip-test"
        const manager = new SessionStateManager()
        const state = manager.get(sessionId)
        state.sessionId = sessionId
        state.initialized = true

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
                "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
                "call-compress",
            ),
        ] as any

        applyCompressTransforms(state, logger, messages)

        const outputs = messages.slice(1).map((message: any) => message.parts[0].state.output)
        assert.deepEqual(outputs, [
            "<compress-context-map>map</compress-context-map>",
            "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
        ])
    })
})
