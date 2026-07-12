import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { PluginConfig } from "../lib/config.ts"
import { applyCompressTransforms } from "../lib/messages/compress-transform.ts"
import { buildContextMap } from "../lib/messages/context-map.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import { createCompressMapTool } from "../lib/tools/compress-map.ts"
import { createCompressTool } from "../lib/tools/compress.ts"
import { handleAutoCommand } from "../lib/commands/auto.ts"
import { loadSessionState } from "../lib/state/persistence.ts"
import { createAutomaticCompressionEventHandler } from "../lib/auto-compression.ts"
import { createCommandExecuteHandler } from "../lib/hooks.ts"

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
    autoCompression: {
        enabled: true,
        contextWindowRatio: 0.9,
        tokenThreshold: 300_000,
        protectedTurns: 3,
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

    it("excludes the active management turn's own trigger message from compress_map's entries", async () => {
        const sessionId = `session-compress-map-active-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Do the actual work"),
                textMessage("m2", sessionId, "Work done", "assistant"),
                textMessage(
                    "manage-trigger",
                    sessionId,
                    "<system-reminder>\nCONTEXT MANAGEMENT REQUESTED\n</system-reminder>\n\n<compress-context-map>stale injected map</compress-context-map>",
                ),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true
            // Not yet completed and not bounded by a later visible user message - this is
            // the currently open management turn.
            state.managementTurns = [{ triggerMessageId: "manage-trigger" }]

            const tool = createCompressMapTool({
                client: createClient(rawMessages),
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            const output = await tool.execute({} as any, createToolContext(sessionId, "call-map-fallback-1") as any)

            assert.doesNotMatch(output, /CONTEXT MANAGEMENT REQUESTED/)
            assert.doesNotMatch(output, /stale injected map/)
            assert.match(output, /\[1\] user: "Do the actual work"/)
            assert.match(output, /Total: 2 messages \+ 0 blocks/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("marks the active management turn completed with a tiny receipt when compress runs mid-manage", async () => {
        const sessionId = `session-compress-marks-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Do the actual work"),
                textMessage("m2", sessionId, "Work done", "assistant"),
                textMessage(
                    "manage-trigger",
                    sessionId,
                    "<system-reminder>\nCONTEXT MANAGEMENT REQUESTED\n</system-reminder>\n\n<compress-context-map>injected map</compress-context-map>",
                ),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true
            state.managementTurns = [{ triggerMessageId: "manage-trigger" }]

            const tool = createCompressTool({
                client: createClient(rawMessages),
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            const output = await tool.execute(
                { from: 1, to: 2, topic: "Prior Work", summary: "Summary of prior work." },
                createToolContext(sessionId, "call-manage-compress-1") as any,
            )

            assert.equal(output, 'Compression complete. Stored [b0] "Prior Work".')
            assert.equal(state.managementTurns.length, 1)
            const turn = state.managementTurns[0]
            assert.equal(typeof turn.completedAt, "string")
            assert.equal(turn.completedCallId, "call-manage-compress-1")
            assert.equal(turn.completedMessageId, "message-call-manage-compress-1")
            assert.equal(
                state.compressionCooldownAfterMessageId,
                "message-call-manage-compress-1",
            )
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("blocks model-initiated compression during cooldown before asking permission", async () => {
        const sessionId = `session-compress-cooldown-block-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const rawMessages = [
            {
                ...toolMessage("compress-anchor", sessionId, "compress", "Compression complete"),
                info: {
                    ...toolMessage("compress-anchor", sessionId, "compress", "Compression complete").info,
                    time: { created: Date.now(), completed: Date.now() },
                },
            },
            textMessage("normal-user", sessionId, "Continue"),
            {
                ...textMessage("normal-assistant", sessionId, "Progress", "assistant"),
                info: {
                    ...textMessage("normal-assistant", sessionId, "Progress", "assistant").info,
                    time: { created: Date.now(), completed: Date.now() },
                },
            },
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.compressionCooldownAfterMessageId = "compress-anchor"
        let askCalls = 0
        const tool = createCompressTool({
            client: createClient(rawMessages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const toolContext = {
            ...createToolContext(sessionId, "call-blocked"),
            ask: async () => {
                askCalls++
            },
        }

        const output = await tool.execute(
            { from: 1, to: 1, topic: "Blocked", summary: "Must not be stored." },
            toolContext as any,
        )

        assert.match(output, /Wait 2 more assistant responses/)
        assert.match(output, /Only the user may override.*`\/compress manage`/)
        assert.equal(askCalls, 0)
        assert.equal(state.compressSummaries.length, 0)
        assert.equal(state.compressionCooldownAfterMessageId, "compress-anchor")
    })

    it("does not compress or replace state when persisted session data cannot be loaded", async () => {
        const sessionId = `session-compress-load-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const filePath = getSessionFilePath(sessionId)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, "{invalid-json", "utf8")
        const rawMessages = [
            textMessage("load-fail-m1", sessionId, "Prior work"),
            textMessage("load-fail-m2", sessionId, "Prior result", "assistant"),
        ]
        const stateManager = new SessionStateManager()
        let askCalls = 0
        const tool = createCompressTool({
            client: createClient(rawMessages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const toolContext = {
            ...createToolContext(sessionId, "load-fail"),
            ask: async () => {
                askCalls++
            },
        }

        try {
            await assert.rejects(
                tool.execute(
                    {
                        from: 1,
                        to: 2,
                        topic: "Prior Work",
                        summary: "This must not be stored.",
                    },
                    toolContext as any,
                ),
                /could not load saved session state/,
            )
            assert.equal(askCalls, 0)
            assert.equal(stateManager.get(sessionId).compressSummaries.length, 0)
            assert.equal(await readFile(filePath, "utf8"), "{invalid-json")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("allows an active manual management turn to override and re-arm cooldown", async () => {
        const sessionId = `session-compress-cooldown-manual-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const completed = (message: any) => ({
            ...message,
            info: {
                ...message.info,
                time: { created: Date.now(), completed: Date.now() },
            },
        })
        const rawMessages = [
            textMessage("old-user", sessionId, "Old objective"),
            textMessage("old-assistant", sessionId, "Old result", "assistant"),
            completed(toolMessage("compress-anchor", sessionId, "compress", "Compression complete")),
            textMessage("normal-user", sessionId, "Continue"),
            completed(textMessage("normal-assistant", sessionId, "Progress", "assistant")),
            textMessage("manual-trigger", sessionId, "Explicit manual management"),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.compressionCooldownAfterMessageId = "compress-anchor"
        state.managementTurns = [{ triggerMessageId: "manual-trigger" }]
        let askCalls = 0
        const tool = createCompressTool({
            client: createClient(rawMessages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const toolContext = {
            ...createToolContext(sessionId, "call-manual-override"),
            ask: async () => {
                askCalls++
            },
        }

        try {
            const output = await tool.execute(
                { from: 1, to: 2, topic: "Old Work", summary: "Durable old-work summary." },
                toolContext as any,
            )

            assert.match(output, /^Compression complete/)
            assert.equal(askCalls, 1)
            assert.equal(
                state.compressionCooldownAfterMessageId,
                "message-call-manual-override",
            )
            assert.equal(typeof state.managementTurns[0].completedAt, "string")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("rejects an automatic protected-tail range, then resumes the task after a valid older range", async () => {
        const sessionId = `session-auto-protected-tail-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Completed older work"),
                textMessage("m2", sessionId, "Current active work", "assistant"),
                textMessage(
                    "auto-trigger",
                    sessionId,
                    "<system-reminder>\nAUTOMATIC CONTEXT COMPRESSION REQUIRED\n</system-reminder>",
                ),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true
            state.managementTurns = [
                {
                    triggerMessageId: "auto-trigger",
                    source: "automatic",
                    triggeredByMessageId: "m2",
                    protectedMessageIds: ["m2"],
                    contextTokens: 310_000,
                    thresholdTokens: 300_000,
                },
            ]

            const tool = createCompressTool({
                client: createClient(rawMessages),
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            await assert.rejects(
                () =>
                    tool.execute(
                        {
                            from: 2,
                            to: 2,
                            topic: "Active Work",
                            summary: "This must remain visible.",
                        },
                        createToolContext(sessionId, "call-auto-rejected") as any,
                    ),
                /protected active tail/i,
            )
            assert.equal(state.managementTurns[0].completedAt, undefined)

            const output = await tool.execute(
                {
                    from: 1,
                    to: 1,
                    topic: "Older Work",
                    summary: "Completed older work with all durable decisions.",
                },
                createToolContext(sessionId, "call-auto-valid") as any,
            )

            assert.match(output, /^Compression complete\. Stored \[b0\] "Older Work"\./)
            assert.match(output, /Continue the original task now/)
            assert.match(output, /do not stop for a compression report/)
            assert.equal(typeof state.managementTurns[0].completedAt, "string")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("only completes the relevant active management turn, leaving unrelated stale turns untouched", async () => {
        const sessionId = `session-compress-stale-turns-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("stale-old-user", sessionId, "Older phase request"),
                textMessage("stale-manage", sessionId, "<system-reminder>\nCONTEXT MANAGEMENT REQUESTED\n</system-reminder>"),
                toolMessage("stale-compress", sessionId, "compress", "Compressed range old"),
                textMessage("real-between", sessionId, "Normal follow-up between compressions"),
                textMessage("m1", sessionId, "Do the actual work"),
                textMessage("m2", sessionId, "Work done", "assistant"),
                textMessage(
                    "manage-trigger",
                    sessionId,
                    "<system-reminder>\nCONTEXT MANAGEMENT REQUESTED\n</system-reminder>\n\n<compress-context-map>injected map</compress-context-map>",
                ),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true
            // A stale, already-historical turn (bounded by "real-between") sits alongside
            // the genuinely open one. Only the latter should ever be marked completed.
            state.managementTurns = [
                { triggerMessageId: "stale-manage" },
                { triggerMessageId: "manage-trigger" },
            ]

            const tool = createCompressTool({
                client: createClient(rawMessages),
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            await tool.execute(
                { from: 1, to: 2, topic: "Prior Work", summary: "Summary of prior work." },
                createToolContext(sessionId, "call-manage-compress-2") as any,
            )

            const [staleTurn, activeTurn] = state.managementTurns
            assert.equal(staleTurn.triggerMessageId, "stale-manage")
            assert.equal(staleTurn.completedAt, undefined)
            assert.equal(activeTurn.triggerMessageId, "manage-trigger")
            assert.equal(typeof activeTurn.completedAt, "string")
            assert.equal(activeTurn.completedCallId, "call-manage-compress-2")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("fails honestly and leaves state untouched when persistence fails", async () => {
        // A "/" in the session ID forces writeFileAtomic to fail (no nested directory
        // exists), deterministically simulating a disk save failure without mocking fs.
        const sessionId = `session-compress-save-fails/${Date.now()}-${Math.random().toString(36).slice(2)}`

        const rawMessages = [
            textMessage("m1", sessionId, "Do the actual work"),
            textMessage("m2", sessionId, "Work done", "assistant"),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.sessionId = sessionId
        state.initialized = true

        const baselineCompressedMessageIds = [...state.compressed.messageIds]
        const baselineCompressedToolIds = [...state.compressed.toolIds]
        const baselineSummaries = [...state.compressSummaries]
        const baselineManagementTurns = [...state.managementTurns]
        const baselineStats = { ...state.stats }

        const tool = createCompressTool({
            client: createClient(rawMessages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        await assert.rejects(
            () =>
                tool.execute(
                    { from: 1, to: 2, topic: "Prior Work", summary: "Summary of prior work." },
                    createToolContext(sessionId, "call-fails-1") as any,
                ),
            /could not persist/i,
        )

        assert.deepEqual([...state.compressed.messageIds], baselineCompressedMessageIds)
        assert.deepEqual([...state.compressed.toolIds], baselineCompressedToolIds)
        assert.deepEqual(state.compressSummaries, baselineSummaries)
        assert.deepEqual(state.managementTurns, baselineManagementTurns)
        assert.deepEqual(state.stats, baselineStats)
        assert.equal(state.hasPersistedState, false)
        assert.equal(state.compressionCooldownAfterMessageId, undefined)
    })

    it("preserves a compression cooldown update across an overlapping auto-control write", async () => {
        const sessionId = `session-compress-auto-overlap-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const rawMessages = [
            textMessage("m1", sessionId, "Do the actual work"),
            textMessage("m2", sessionId, "Work done", "assistant"),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        let releaseAsk!: () => void
        let markAskStarted!: () => void
        const askStarted = new Promise<void>((resolve) => {
            markAskStarted = resolve
        })
        const askGate = new Promise<void>((resolve) => {
            releaseAsk = resolve
        })
        const client = {
            ...createClient(rawMessages),
            session: {
                ...createClient(rawMessages).session,
                prompt: async () => ({ data: { info: { id: "ignored" } } }),
            },
        }
        const tool = createCompressTool({
            client,
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const toolContext = {
            ...createToolContext(sessionId, "call-overlap"),
            ask: async () => {
                markAskStarted()
                await askGate
            },
        }

        try {
            const compression = tool.execute(
                { from: 1, to: 2, topic: "Prior Work", summary: "Summary of prior work." },
                toolContext as any,
            )
            await askStarted
            const control = handleAutoCommand({
                client,
                stateManager,
                state,
                config,
                logger,
                sessionId,
                messages: rawMessages as any,
                arguments: ["off"],
            })

            releaseAsk()
            await Promise.all([compression, control])

            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.autoCompressionEnabledOverride, false)
            assert.equal(
                loaded.state.compressionCooldownAfterMessageId,
                "message-call-overlap",
            )
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("rechecks automatic cooldown state after waiting for an overlapping compression", async () => {
        const sessionId = `session-compress-auto-event-overlap-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const oldMessages = [
            textMessage("m1", sessionId, "Do the actual work"),
            textMessage("m2", sessionId, "Work done", "assistant"),
        ]
        const completed = (message: any) => ({
            ...message,
            info: {
                ...message.info,
                providerID: "openai",
                modelID: "gpt-test",
                time: { created: Date.now(), completed: Date.now() },
            },
        })
        const latestMessages = [
            ...oldMessages,
            completed(toolMessage("message-race-compress", sessionId, "compress", "done")),
            textMessage("race-user", sessionId, "Continue"),
            completed(textMessage("race-response", sessionId, "Progress", "assistant")),
        ]
        let messageReads = 0
        let promptCalls = 0
        const client = {
            _client: {},
            session: {
                get: async () => ({ data: {} }),
                messages: async () => ({
                    data: messageReads++ === 0 ? [...oldMessages] : [...latestMessages],
                }),
                promptAsync: async () => {
                    promptCalls++
                    return { data: undefined }
                },
            },
        }
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        let releaseAsk!: () => void
        let markAskStarted!: () => void
        const askStarted = new Promise<void>((resolve) => {
            markAskStarted = resolve
        })
        const askGate = new Promise<void>((resolve) => {
            releaseAsk = resolve
        })
        const tool = createCompressTool({
            client,
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const toolContext = {
            ...createToolContext(sessionId, "race-compress"),
            ask: async () => {
                markAskStarted()
                await askGate
            },
        }
        const autoConfig: PluginConfig = {
            ...config,
            autoCompression: {
                ...config.autoCompression,
                tokenThreshold: 100,
                protectedTurns: 0,
            },
        }
        const autoHandler = createAutomaticCompressionEventHandler(
            client,
            stateManager,
            logger,
            autoConfig,
        )

        try {
            const compression = tool.execute(
                { from: 1, to: 2, topic: "Prior Work", summary: "Summary of prior work." },
                toolContext as any,
            )
            await askStarted
            const autoEvent = autoHandler({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            ...latestMessages.at(-1).info,
                            tokens: { total: 1_000 },
                        },
                    },
                },
            } as any)

            releaseAsk()
            await Promise.all([compression, autoEvent])

            assert.equal(
                state.compressionCooldownAfterMessageId,
                "message-race-compress",
            )
            assert.equal(promptCalls, 0)
            assert.equal(
                state.managementTurns.filter((turn) => turn.source === "automatic").length,
                0,
            )
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("preserves completed compression state when manual manage waits behind it", async () => {
        const sessionId = `session-compress-manage-overlap-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const rawMessages = [
            textMessage("m1", sessionId, "Do the actual work"),
            textMessage("m2", sessionId, "Work done", "assistant"),
        ]
        let releaseAsk!: () => void
        let markAskStarted!: () => void
        const askStarted = new Promise<void>((resolve) => {
            markAskStarted = resolve
        })
        const askGate = new Promise<void>((resolve) => {
            releaseAsk = resolve
        })
        let promptCalls = 0
        const client = {
            _client: {},
            session: {
                get: async () => ({ data: {} }),
                messages: async () => ({ data: [...rawMessages] }),
                prompt: async (input: any) => {
                    promptCalls++
                    return {
                        data: {
                            info: {
                                id: "manage-assistant",
                                role: "assistant",
                                parentID: input.body.messageID,
                            },
                        },
                    }
                },
            },
        }
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        const tool = createCompressTool({
            client,
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const toolContext = {
            ...createToolContext(sessionId, "manage-overlap"),
            ask: async () => {
                markAskStarted()
                await askGate
            },
        }
        const commandHandler = createCommandExecuteHandler(client, stateManager, logger, config)

        try {
            const compression = tool.execute(
                { from: 1, to: 2, topic: "Prior Work", summary: "Summary of prior work." },
                toolContext as any,
            )
            await askStarted
            const output = { parts: [{ type: "text", text: "default" }], cancelled: false }
            const manage = commandHandler(
                { command: "compress", sessionID: sessionId, arguments: "manage" },
                output,
            )

            releaseAsk()
            await Promise.all([compression, manage])

            assert.equal(promptCalls, 1)
            assert.equal(output.cancelled, true)
            assert.equal(state.compressSummaries.length, 1)
            assert.equal(state.compressionCooldownAfterMessageId, "message-manage-overlap")
            assert.equal(state.managementTurns.length, 1)

            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.compressSummaries.length, 1)
            assert.equal(
                loaded.state.compressionCooldownAfterMessageId,
                "message-manage-overlap",
            )
            assert.equal(loaded.state.managementTurns.length, 1)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("preserves a completed management marker when its overlapping prompt later fails", async () => {
        const sessionId = `session-manage-prompt-compress-race-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const rawMessages = [
            textMessage("race-m1", sessionId, "Compress this completed objective"),
            textMessage("race-m2", sessionId, "Completed result", "assistant"),
        ]
        let releasePrompt!: () => void
        let markPromptStarted!: () => void
        const promptStarted = new Promise<void>((resolve) => {
            markPromptStarted = resolve
        })
        const promptGate = new Promise<void>((resolve) => {
            releasePrompt = resolve
        })
        const toasts: any[] = []
        const client = {
            _client: {},
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input)
                },
            },
            session: {
                get: async () => ({ data: {} }),
                messages: async () => ({ data: rawMessages }),
                prompt: async (input: any) => {
                    rawMessages.push(
                        textMessage(input.body.messageID, sessionId, "Manage compression"),
                    )
                    markPromptStarted()
                    await promptGate
                    throw new Error("prompt transport failed")
                },
            },
        }
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        const commandHandler = createCommandExecuteHandler(client, stateManager, logger, config)
        const tool = createCompressTool({
            client,
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        try {
            const output = { parts: [{ type: "text", text: "default" }], cancelled: false }
            const manage = commandHandler(
                { command: "compress", sessionID: sessionId, arguments: "manage" },
                output,
            )
            await promptStarted

            const compression = await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Completed Work",
                    summary: "The completed objective and result were preserved.",
                },
                createToolContext(sessionId, "prompt-race-compress") as any,
            )
            assert.match(compression, /^Compression complete/)
            assert.equal(typeof state.managementTurns[0].completedAt, "string")

            releasePrompt()
            await manage

            assert.equal(output.cancelled, true)
            assert.equal(state.managementTurns.length, 1)
            assert.equal(typeof state.managementTurns[0].completedAt, "string")
            assert.equal(
                state.managementTurns[0].completedMessageId,
                "message-prompt-race-compress",
            )

            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.managementTurns.length, 1)
            assert.equal(typeof loaded.state.managementTurns[0].completedAt, "string")
            assert.equal(
                loaded.state.managementTurns[0].completedMessageId,
                "message-prompt-race-compress",
            )
            assert.equal(toasts.length, 1)
        } finally {
            releasePrompt?.()
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

            assert.match(firstOutput, /^Compression complete\./)
            assert.doesNotMatch(firstOutput, /<compress-context-map>/)
            assert.equal(firstOutput, 'Compression complete. Stored [b0] "Phase A".')

            const secondOutput = await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase B",
                    summary: "Higher-fidelity summary for phase B.",
                },
                createToolContext(sessionId, "call-compress-2") as any,
            )

            assert.equal(secondOutput, 'Compression complete. Stored [b1] "Phase B".')

            const thirdOutput = await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase C",
                    summary: "Steady summary for phase C.",
                },
                createToolContext(sessionId, "call-compress-3") as any,
            )

            assert.equal(thirdOutput, 'Compression complete. Stored [b2] "Phase C".')

            const fourthOutput = await tool.execute(
                {
                    from: "b1",
                    to: "b1",
                    topic: "Phase B Updated",
                    summary: "Much terser updated summary for phase B.",
                },
                createToolContext(sessionId, "call-compress-4") as any,
            )

            assert.equal(fourthOutput, 'Compression complete. Stored [b1] "Phase B Updated".')
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

            assert.equal(secondOutput, 'Compression complete. Stored [b0] "Older Phase Condensed".')
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

            assert.equal(secondOutput, 'Compression complete. Stored [b0] "Combined A+B".')
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
