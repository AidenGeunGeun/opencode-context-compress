import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { PluginConfig } from "../lib/config.ts"
import { applyCompressTransforms } from "../lib/messages/compress-transform.ts"
import {
    buildContextMap,
    createCompressionMapSnapshot,
} from "../lib/messages/context-map.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import { createCompressMapTool } from "../lib/tools/compress-map.ts"
import { createCompressTool } from "../lib/tools/compress.ts"
import { handleAutoCommand } from "../lib/commands/auto.ts"
import { loadSessionState, saveSessionState } from "../lib/state/persistence.ts"
import { createAutomaticCompressionEventHandler } from "../lib/auto-compression.ts"
import {
    createChatMessageHandler,
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
} from "../lib/hooks.ts"

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    saveContext: async () => {},
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

const pinCompressionMap = (
    state: ReturnType<SessionStateManager["get"]>,
    rawMessages: any[],
    options: {
        triggerMessageId?: string
        source?: "automatic"
        protectedMessageIds?: string[]
        reuseExistingTurn?: boolean
    } = {},
) => {
    const triggerMessageId =
        options.triggerMessageId ?? `manage-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let turn = options.reuseExistingTurn
        ? state.managementTurns.find(
              (candidate) => candidate.triggerMessageId === triggerMessageId,
          )
        : undefined
    if (!turn) {
        turn = {
            triggerMessageId,
            ...(options.source === "automatic" ? { source: "automatic" as const } : {}),
            ...(options.protectedMessageIds
                ? { protectedMessageIds: options.protectedMessageIds }
                : {}),
        }
        state.managementTurns.push(turn)
    }
    const triggerIndex = rawMessages.findIndex(
        (message) => message.info.id === triggerMessageId,
    )
    const preManagementMessages =
        triggerIndex === -1 ? rawMessages : rawMessages.slice(0, triggerIndex)
    const contextMap = buildContextMap(
        preManagementMessages as any,
        state,
        logger,
        undefined,
        turn.source === "automatic"
            ? { protectedMessageIds: turn.protectedMessageIds ?? [] }
            : undefined,
    )
    state.persistenceSynchronized = true
    state.compressionMapSnapshot = createCompressionMapSnapshot(triggerMessageId, contextMap)
    return contextMap
}

describe("compression management tools", () => {
    it("pins a 148-entry map so a later sparse seven-message host response cannot change compression", async () => {
        const sessionId = `session-compress-pinned-148-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const pinnedMessages = Array.from({ length: 148 }, (_, index) =>
                textMessage(
                    `pinned-${String(index + 1).padStart(3, "0")}`,
                    sessionId,
                    `Pinned historical message ${index + 1}`,
                    index % 2 === 0 ? "user" : "assistant",
                ),
            )
            const trigger = textMessage(
                "manage-trigger",
                sessionId,
                "<system-reminder>CONTEXT MANAGEMENT REQUESTED</system-reminder>",
            )
            const sparseLaterResponse = [
                pinnedMessages[0],
                pinnedMessages[1],
                pinnedMessages[2],
                pinnedMessages[145],
                pinnedMessages[146],
                pinnedMessages[147],
                trigger,
            ]
            let messageReads = 0
            const client = {
                session: {
                    get: async () => ({ data: {} }),
                    messages: async () => ({
                        data:
                            messageReads++ === 0
                                ? [...pinnedMessages, trigger]
                                : sparseLaterResponse,
                    }),
                },
            }
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true
            state.managementTurns = [{ triggerMessageId: trigger.info.id }]

            const mapTool = createCompressMapTool({
                client,
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })
            const compressTool = createCompressTool({
                client,
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            const map = await mapTool.execute(
                {} as any,
                createToolContext(sessionId, "call-map-148") as any,
            )
            assert.match(map, /Total: 148 messages \+ 0 blocks/)

            const output = await compressTool.execute(
                {
                    from: 1,
                    to: 148,
                    topic: "Pinned History",
                    summary: "All 148 pinned historical messages are preserved here.",
                },
                createToolContext(sessionId, "call-compress-148") as any,
            )

            assert.match(output, /^Compression complete/)
            assert.equal(messageReads, 1, "compress must not retrieve the transcript after the map is pinned")
            assert.deepEqual(state.compressSummaries[0].messageIds, pinnedMessages.map((message) => message.info.id))
            assert.deepEqual([...state.compressed.messageIds], pinnedMessages.map((message) => message.info.id))
            assert.equal(state.compressionMapSnapshot, undefined)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("allows compress_map during normal work and excludes the current user turn", async () => {
        const sessionId = `session-compress-map-normal-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        let askCalls = 0
        const messages = [
            textMessage("old-user", sessionId, "Earlier request"),
            textMessage("old-assistant", sessionId, "Earlier result", "assistant"),
            textMessage("current-user", sessionId, "Inspect and compress if useful"),
            textMessage("current-assistant", sessionId, "In-progress reasoning", "assistant"),
        ]
        const mapTool = createCompressMapTool({
            client: createClient(messages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        try {
            const output = await mapTool.execute(
                {} as any,
                {
                    ...createToolContext(sessionId, "normal-map"),
                    ask: async () => {
                        askCalls++
                    },
                } as any,
            )
            assert.match(output, /Total: 2 messages \+ 0 blocks/)
            assert.doesNotMatch(output, /Inspect and compress if useful|In-progress reasoning/)
            assert.equal(askCalls, 1)
            assert.equal(state.compressionMapSnapshot?.source, "normal")
            assert.equal(state.compressionMapSnapshot?.triggerMessageId, "current-user")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("allows normal-turn compression after compress_map without completing a management turn", async () => {
        const sessionId = `session-compress-normal-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const messages = [
            textMessage("old-user", sessionId, "Earlier request"),
            textMessage("old-assistant", sessionId, "Earlier result", "assistant"),
            textMessage("current-user", sessionId, "Continue the active task"),
        ]
        const stateManager = new SessionStateManager()
        const mapTool = createCompressMapTool({
            client: createClient(messages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const compressTool = createCompressTool({
            client: createClient(messages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        try {
            await mapTool.execute({} as any, createToolContext(sessionId, "normal-map") as any)
            const output = await compressTool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Earlier Work",
                    summary: "The earlier request and result are preserved.",
                },
                createToolContext(sessionId, "normal-compress") as any,
            )
            const state = stateManager.get(sessionId)
            assert.match(output, /^Compression complete/)
            assert.deepEqual(state.compressSummaries[0].messageIds, ["old-user", "old-assistant"])
            assert.deepEqual(state.managementTurns, [])
            assert.equal(state.compressionMapSnapshot, undefined)
            assert.equal(state.compressionCooldownAfterMessageId, "message-normal-compress")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("reloads a normal-turn pin while the same visible user boundary remains current", async () => {
        const sessionId = `session-compress-normal-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const messages = [
            textMessage("old-user", sessionId, "Earlier request"),
            textMessage("old-assistant", sessionId, "Earlier result", "assistant"),
            textMessage("current-user", sessionId, "Continue"),
        ]
        const firstManager = new SessionStateManager()
        const mapTool = createCompressMapTool({
            client: createClient(messages),
            stateManager: firstManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        try {
            await mapTool.execute({} as any, createToolContext(sessionId, "normal-map-reload") as any)

            const reloadedManager = new SessionStateManager()
            const transform = createChatMessageTransformHandler(
                { session: { get: async () => ({ data: {} }) } },
                reloadedManager,
                logger,
                config,
            )
            await transform({}, { messages: structuredClone(messages) as any })
            const reloadedState = reloadedManager.get(sessionId)
            assert.equal(reloadedState.compressionMapSnapshot?.source, "normal")
            assert.equal(reloadedState.compressionMapSnapshot?.triggerMessageId, "current-user")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("replaces the current-turn snapshot when a later successful map is smaller", async () => {
        const sessionId = `session-compress-map-replace-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const all = Array.from({ length: 12 }, (_, index) =>
            textMessage(`m${index + 1}`, sessionId, `History ${index + 1}`, index % 2 ? "assistant" : "user"),
        )
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const smaller = [all[0], all[1], all[10], all[11], trigger]
        let reads = 0
        const client = {
            session: {
                get: async () => ({ data: {} }),
                messages: async () => {
                    if (reads++ === 0) return { data: [...all, trigger] }
                    if (reads === 2) return { data: smaller }
                    throw new Error("host messages unavailable")
                },
            },
        }
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.managementTurns = [{ triggerMessageId: trigger.info.id }]
        const mapTool = createCompressMapTool({
            client,
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        try {
            assert.match(
                await mapTool.execute({} as any, createToolContext(sessionId, "map-large") as any),
                /Total: 12 messages/,
            )
            assert.equal(state.compressionMapSnapshot?.entries.length, 12)
            assert.match(
                await mapTool.execute({} as any, createToolContext(sessionId, "map-small") as any),
                /Total: 4 messages/,
            )
            assert.equal(state.compressionMapSnapshot?.entries.length, 4)
            assert.equal(Array.isArray(state.compressionMapSnapshot), false)
            const lastSuccessfulSnapshot = structuredClone(state.compressionMapSnapshot)
            await assert.rejects(
                mapTool.execute({} as any, createToolContext(sessionId, "map-fetch-fails") as any),
                /No new map became authoritative/,
            )
            assert.deepEqual(state.compressionMapSnapshot, lastSuccessfulSnapshot)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("does not return an executable-looking map when snapshot persistence fails", async () => {
        const sessionId = `session-compress-map-save-fails/${Date.now()}-${Math.random().toString(36).slice(2)}`
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.managementTurns = [{ triggerMessageId: trigger.info.id }]
        const mapTool = createCompressMapTool({
            client: createClient([textMessage("m1", sessionId, "History"), trigger]),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        await assert.rejects(
            mapTool.execute({} as any, createToolContext(sessionId, "map-save-fails") as any),
            /could not save this snapshot.*No new map became authoritative/s,
        )
        assert.equal(state.compressionMapSnapshot, undefined)
    })

    it("compresses only seven entries when the first authoritative map honestly contains seven", async () => {
        const sessionId = `session-compress-map-seven-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const seven = Array.from({ length: 7 }, (_, index) =>
            textMessage(`m${index + 1}`, sessionId, `Sparse visible ${index + 1}`, index % 2 ? "assistant" : "user"),
        )
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.managementTurns = [{ triggerMessageId: trigger.info.id }]
        const client = createClient([...seven, trigger])
        const mapTool = createCompressMapTool({ client, stateManager, logger, config, workingDirectory: "/tmp" })
        const compressTool = createCompressTool({ client, stateManager, logger, config, workingDirectory: "/tmp" })

        try {
            assert.match(
                await mapTool.execute({} as any, createToolContext(sessionId, "map-seven") as any),
                /Total: 7 messages/,
            )
            await compressTool.execute(
                { from: 1, to: 7, topic: "Sparse History", summary: "Only the seven visible entries." },
                createToolContext(sessionId, "compress-seven") as any,
            )
            assert.deepEqual(state.compressSummaries[0].messageIds, seven.map((message) => message.info.id))
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("omits an unsafe block label when a sparse pinned map cannot see an older stored block", async () => {
        const sessionId = `session-compress-sparse-block-label-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const visible = [
            textMessage("m3", sessionId, "Visible later request"),
            textMessage("m4", sessionId, "Visible later result", "assistant"),
        ]
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.compressed.messageIds = new Set(["m1", "m2"])
        state.compressSummaries = [
            {
                anchorMessageId: "m1",
                messageIds: ["m1", "m2"],
                summary: "Older stored block omitted by the sparse host response.",
                topic: "Older Block",
            },
        ]
        state.managementTurns = [{ triggerMessageId: trigger.info.id }]
        const client = createClient([...visible, trigger])
        const mapTool = createCompressMapTool({ client, stateManager, logger, config, workingDirectory: "/tmp" })
        const compressTool = createCompressTool({ client, stateManager, logger, config, workingDirectory: "/tmp" })

        try {
            await mapTool.execute({} as any, createToolContext(sessionId, "map-sparse-block") as any)
            const receipt = await compressTool.execute(
                { from: 1, to: 2, topic: "Later Work", summary: "The visible later work." },
                createToolContext(sessionId, "compress-sparse-block") as any,
            )

            assert.match(receipt, /Stored "Later Work" durably/)
            assert.doesNotMatch(receipt, /Stored \[b\d+\]/)
            assert.equal(state.compressSummaries.length, 2)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("clears the pinned snapshot when a later visible user message ends the management turn", async () => {
        const sessionId = `session-compress-map-user-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const client = createClient([
            textMessage("m1", sessionId, "Completed work"),
            trigger,
        ])
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.managementTurns = [{ triggerMessageId: trigger.info.id }]
        const mapTool = createCompressMapTool({ client, stateManager, logger, config, workingDirectory: "/tmp" })

        try {
            await mapTool.execute({} as any, createToolContext(sessionId, "map-before-user") as any)
            assert.ok(state.compressionMapSnapshot)

            const handler = createChatMessageHandler(stateManager, logger)
            await handler(
                { sessionID: sessionId, messageID: "later-user", variant: "high" },
                {
                    message: textMessage("later-user", sessionId, "Continue normally").info,
                    parts: [{ type: "text", text: "Continue normally" }],
                },
            )

            assert.equal(state.compressionMapSnapshot, undefined)
            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.compressionMapSnapshot, undefined)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("queues a racing visible user behind compress_map and invalidates the newly committed snapshot", async () => {
        const sessionId = `session-compress-map-user-race-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const mapMessages = [textMessage("m1", sessionId, "Completed work"), trigger]
        const laterUser = textMessage("later-user", sessionId, "Continue normally")
        let releaseMessages!: () => void
        let markMessagesStarted!: () => void
        const messagesStarted = new Promise<void>((resolve) => {
            markMessagesStarted = resolve
        })
        const messagesGate = new Promise<void>((resolve) => {
            releaseMessages = resolve
        })
        const client = {
            session: {
                get: async () => ({ data: {} }),
                messages: async () => {
                    markMessagesStarted()
                    await messagesGate
                    return { data: mapMessages }
                },
            },
        }
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.managementTurns = [{ triggerMessageId: trigger.info.id }]
        const mapTool = createCompressMapTool({
            client,
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const compressTool = createCompressTool({
            client,
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const userHandler = createChatMessageHandler(stateManager, logger)

        try {
            const mapCreation = mapTool.execute(
                {} as any,
                createToolContext(sessionId, "map-racing-user") as any,
            )
            await messagesStarted

            let userHandlerCompleted = false
            const userInvalidation = userHandler(
                { sessionID: sessionId, messageID: laterUser.info.id },
                { message: laterUser.info, parts: laterUser.parts },
            ).then(() => {
                userHandlerCompleted = true
            })
            await new Promise<void>((resolve) => setImmediate(resolve))
            assert.equal(userHandlerCompleted, false)
            assert.equal(state.compressionMapSnapshot, undefined)

            releaseMessages()
            assert.match(await mapCreation, /<compress-context-map>/)
            await userInvalidation

            assert.equal(state.compressionMapSnapshot, undefined)
            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.compressionMapSnapshot, undefined)

            let askCalls = 0
            await assert.rejects(
                compressTool.execute(
                    { from: 1, to: 1, topic: "Stale", summary: "Must not run." },
                    {
                        ...createToolContext(sessionId, "compress-after-racing-user"),
                        ask: async () => {
                            askCalls++
                        },
                    } as any,
                ),
                /no authoritative map/,
            )
            assert.equal(askCalls, 0)
            assert.equal(state.compressSummaries.length, 0)
            assert.equal(state.compressed.messageIds.size, 0)
        } finally {
            releaseMessages?.()
            await cleanupSessionFile(sessionId)
        }
    })

    it("keeps a failed visible-user cleanup blocked through compress_map reload and compress", async () => {
        const nestedSessionRoot = `session-compress-map-user-cleanup-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const sessionId = `${nestedSessionRoot}/state`
        const sessionDirectory = dirname(getSessionFilePath(sessionId))
        const backupDirectory = `${sessionDirectory}-backup`
        await rm(sessionDirectory, { recursive: true, force: true })
        await rm(backupDirectory, { recursive: true, force: true })
        await mkdir(sessionDirectory, { recursive: true })
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const laterUser = textMessage("later-user", sessionId, "Continue normally")
        const messages = [textMessage("m1", sessionId, "Completed work"), trigger, laterUser]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.managementTurns = [{ triggerMessageId: trigger.info.id }]
        pinCompressionMap(state, messages.slice(0, 2), {
            triggerMessageId: trigger.info.id,
            reuseExistingTurn: true,
        })
        assert.equal(await saveSessionState(state, logger), true)
        const originalSnapshot = structuredClone(state.compressionMapSnapshot)
        const userHandler = createChatMessageHandler(stateManager, logger)
        const blockStateWrites = () => {
            renameSync(sessionDirectory, backupDirectory)
            writeFileSync(sessionDirectory, "not a directory")
        }
        const restoreStateFile = () => {
            rmSync(sessionDirectory, { force: true })
            renameSync(backupDirectory, sessionDirectory)
        }
        let staleStateReloaded = false
        const reloadLogger = {
            ...logger,
            info: (message: string) => {
                if (message === "Loaded session state from disk" && !staleStateReloaded) {
                    staleStateReloaded = true
                    blockStateWrites()
                }
            },
        } as any
        const mapTool = createCompressMapTool({
            client: createClient(messages),
            stateManager,
            logger: reloadLogger,
            config,
            workingDirectory: "/tmp",
        })
        const compressTool = createCompressTool({
            client: createClient(messages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        try {
            blockStateWrites()
            await userHandler(
                { sessionID: sessionId, messageID: laterUser.info.id },
                { message: laterUser.info, parts: laterUser.parts },
            )
            restoreStateFile()

            assert.deepEqual(state.compressionMapSnapshot, originalSnapshot)
            assert.equal(state.persistenceSynchronized, false)

            await assert.rejects(
                mapTool.execute({} as any, createToolContext(sessionId, "map-after-user-cleanup-failure") as any),
                /could not load saved session state/,
            )
            restoreStateFile()
            assert.equal(staleStateReloaded, true)
            assert.deepEqual(state.compressionMapSnapshot, originalSnapshot)
            assert.equal(state.persistenceSynchronized, false)

            await assert.rejects(
                compressTool.execute(
                    { from: 1, to: 1, topic: "Stale", summary: "Must not run." },
                    createToolContext(sessionId, "compress-after-user-cleanup-failure") as any,
                ),
                /cannot trust saved session state/,
            )
        } finally {
            if (existsSync(sessionDirectory) && existsSync(backupDirectory)) {
                rmSync(sessionDirectory, { recursive: true, force: true })
                renameSync(backupDirectory, sessionDirectory)
            }
            await rm(sessionDirectory, { recursive: true, force: true })
            await rm(backupDirectory, { recursive: true, force: true })
        }
    })

    it("reconciles a stale persisted snapshot during the next transcript transform after restart", async () => {
        const sessionId = `session-compress-map-restart-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const laterUser = textMessage("later-user", sessionId, "Resume ordinary work")
        const messages = [textMessage("m1", sessionId, "History"), trigger, laterUser]
        const initialManager = new SessionStateManager()
        const initialState = initialManager.get(sessionId)
        initialState.initialized = true
        initialState.persistenceSynchronized = true
        initialState.managementTurns = [{ triggerMessageId: trigger.info.id }]
        pinCompressionMap(initialState, messages.slice(0, 2), {
            triggerMessageId: trigger.info.id,
            reuseExistingTurn: true,
        })
        const saved = await saveSessionState(initialState, logger)
        assert.equal(saved, true)

        try {
            const reloadedManager = new SessionStateManager()
            const handler = createChatMessageTransformHandler(
                { session: { get: async () => ({ data: {} }) } },
                reloadedManager,
                logger,
                config,
            )
            const output = { messages: structuredClone(messages) as any }
            await handler({}, output)

            const reloadedState = reloadedManager.get(sessionId)
            assert.equal(reloadedState.compressionMapSnapshot, undefined)
            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.compressionMapSnapshot, undefined)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("invalidates a pre-compaction persisted snapshot after restart", async () => {
        const sessionId = `session-compress-map-compaction-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const compaction = {
            ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant"),
            info: {
                ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant").info,
                summary: true,
                time: { created: Date.now() + 10_000 },
            },
        }
        const messages = [textMessage("m1", sessionId, "History"), trigger, compaction]
        const initialManager = new SessionStateManager()
        const initialState = initialManager.get(sessionId)
        initialState.initialized = true
        initialState.persistenceSynchronized = true
        initialState.compressed.messageIds = new Set(["m1"])
        initialState.compressSummaries = [
            {
                anchorMessageId: "m1",
                messageIds: ["m1"],
                summary: "Pre-compaction plugin summary.",
            },
        ]
        initialState.managementTurns = [{ triggerMessageId: trigger.info.id }]
        pinCompressionMap(initialState, messages.slice(0, 2), {
            triggerMessageId: trigger.info.id,
            reuseExistingTurn: true,
        })
        assert.equal(await saveSessionState(initialState, logger), true)

        try {
            const reloadedManager = new SessionStateManager()
            const handler = createChatMessageTransformHandler(
                { session: { get: async () => ({ data: {} }) } },
                reloadedManager,
                logger,
                config,
            )
            await handler({}, { messages: structuredClone(messages) as any })

            const reloadedState = reloadedManager.get(sessionId)
            assert.equal(reloadedState.compressionMapSnapshot, undefined)
            assert.equal(reloadedState.compressed.messageIds.size, 0)
            assert.deepEqual(reloadedState.compressSummaries, [])
            assert.deepEqual(reloadedState.managementTurns, [])
            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.compressionMapSnapshot, undefined)
            assert.deepEqual(loaded.state.compressed.messageIds, [])
            assert.deepEqual(loaded.state.compressSummaries, [])
            assert.deepEqual(loaded.state.managementTurns, [])
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("fully resets missing-trigger pre-compaction state even after a later generic save timestamp", async () => {
        const sessionId = `session-compress-map-compaction-missing-trigger-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const oldMessage = textMessage("old-message", sessionId, "Pre-compaction history")
        const oldTrigger = textMessage("old-manage-trigger", sessionId, "Manage")
        const compaction = {
            ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant"),
            info: {
                ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant").info,
                summary: true,
                time: { created: Date.now() - 1_000 },
            },
        }
        const messages = [
            compaction,
            textMessage("post-compaction-user", sessionId, "Continue after compaction"),
        ]
        const initialManager = new SessionStateManager()
        const initialState = initialManager.get(sessionId)
        initialState.initialized = true
        initialState.persistenceSynchronized = true
        initialState.compressed.messageIds = new Set([oldMessage.info.id])
        initialState.compressed.toolIds = new Set(["old-tool-call"])
        initialState.compressSummaries = [
            {
                anchorMessageId: oldMessage.info.id,
                messageIds: [oldMessage.info.id],
                summary: "Pre-compaction plugin summary.",
            },
        ]
        initialState.managementTurns = [{ triggerMessageId: oldTrigger.info.id }]
        pinCompressionMap(initialState, [oldMessage, oldTrigger], {
            triggerMessageId: oldTrigger.info.id,
            reuseExistingTurn: true,
        })
        assert.equal(await saveSessionState(initialState, logger), true)

        try {
            const reloadedManager = new SessionStateManager()
            const handler = createChatMessageTransformHandler(
                { session: { get: async () => ({ data: {} }) } },
                reloadedManager,
                logger,
                config,
            )
            await handler({}, { messages: structuredClone(messages) as any })

            const reloadedState = reloadedManager.get(sessionId)
            assert.equal(reloadedState.persistenceSynchronized, true)
            assert.equal(reloadedState.compressionMapSnapshot, undefined)
            assert.equal(reloadedState.compressed.messageIds.size, 0)
            assert.equal(reloadedState.compressed.toolIds.size, 0)
            assert.deepEqual(reloadedState.compressSummaries, [])
            assert.deepEqual(reloadedState.managementTurns, [])
            assert.equal(reloadedState.lastCompaction, compaction.info.time.created)

            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.compressionMapSnapshot, undefined)
            assert.deepEqual(loaded.state.compressed.messageIds, [])
            assert.deepEqual(loaded.state.compressed.toolIds, [])
            assert.deepEqual(loaded.state.compressSummaries, [])
            assert.deepEqual(loaded.state.managementTurns, [])
            assert.equal(loaded.state.lastCompaction, compaction.info.time.created)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("retains compression state whose physical messages follow the latest native compaction", async () => {
        const sessionId = `session-compress-map-post-compaction-state-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const compaction = {
            ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant"),
            info: {
                ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant").info,
                summary: true,
                time: { created: Date.now() - 1_000 },
            },
        }
        const postCompactionMessage = textMessage(
            "post-compaction-message",
            sessionId,
            "Work completed after native compaction",
        )
        const messages = [compaction, postCompactionMessage]
        const initialManager = new SessionStateManager()
        const initialState = initialManager.get(sessionId)
        initialState.initialized = true
        initialState.persistenceSynchronized = true
        initialState.compressed.messageIds = new Set([postCompactionMessage.info.id])
        initialState.compressed.toolIds = new Set(["post-compaction-tool"])
        initialState.compressSummaries = [
            {
                anchorMessageId: postCompactionMessage.info.id,
                messageIds: [postCompactionMessage.info.id],
                summary: "Post-compaction plugin summary.",
            },
        ]
        assert.equal(await saveSessionState(initialState, logger), true)

        try {
            const reloadedManager = new SessionStateManager()
            const handler = createChatMessageTransformHandler(
                { session: { get: async () => ({ data: {} }) } },
                reloadedManager,
                logger,
                config,
            )
            await handler({}, { messages: structuredClone(messages) as any })

            const reloadedState = reloadedManager.get(sessionId)
            assert.equal(reloadedState.persistenceSynchronized, true)
            assert.equal(reloadedState.lastCompaction, compaction.info.time.created)
            assert.deepEqual([...reloadedState.compressed.messageIds], [postCompactionMessage.info.id])
            assert.deepEqual([...reloadedState.compressed.toolIds], ["post-compaction-tool"])
            assert.equal(reloadedState.compressSummaries.length, 1)

            const sparseMessages = [
                compaction,
                textMessage("sparse-post-compaction-user", sessionId, "Sparse later response"),
            ]
            await handler({}, { messages: structuredClone(sparseMessages) as any })
            assert.deepEqual([...reloadedState.compressed.messageIds], [postCompactionMessage.info.id])
            assert.equal(reloadedState.compressSummaries.length, 1)

            const secondRestartManager = new SessionStateManager()
            const secondRestartHandler = createChatMessageTransformHandler(
                { session: { get: async () => ({ data: {} }) } },
                secondRestartManager,
                logger,
                config,
            )
            await secondRestartHandler({}, { messages: structuredClone(sparseMessages) as any })
            const secondRestartState = secondRestartManager.get(sessionId)
            assert.deepEqual([...secondRestartState.compressed.messageIds], [postCompactionMessage.info.id])
            assert.equal(secondRestartState.compressSummaries.length, 1)

            await secondRestartHandler({}, { messages: structuredClone(messages) as any })
            assert.deepEqual([...secondRestartState.compressed.messageIds], [postCompactionMessage.info.id])
            assert.equal(secondRestartState.compressSummaries.length, 1)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("keeps live pin authority fail-closed when compaction cleanup cannot be saved", async () => {
        const sessionId = `session-compress-map-compaction-save-fails/${Date.now()}-${Math.random().toString(36).slice(2)}`
        const trigger = textMessage("manage-trigger", sessionId, "Manage")
        const compaction = {
            ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant"),
            info: {
                ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant").info,
                summary: true,
                time: { created: Date.now() + 1 },
            },
        }
        const messages = [textMessage("m1", sessionId, "History"), trigger, compaction]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.persistenceSynchronized = true
        state.managementTurns = [{ triggerMessageId: trigger.info.id }]
        pinCompressionMap(state, messages.slice(0, 2), {
            triggerMessageId: trigger.info.id,
            reuseExistingTurn: true,
        })
        const originalSnapshot = structuredClone(state.compressionMapSnapshot)
        const handler = createChatMessageTransformHandler(
            { session: { get: async () => ({ data: {} }) } },
            stateManager,
            logger,
            config,
        )
        const mapTool = createCompressMapTool({
            client: createClient(messages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        const compressTool = createCompressTool({
            client: createClient(messages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        await handler({}, { messages: structuredClone(messages) as any })

        assert.deepEqual(state.compressionMapSnapshot, originalSnapshot)
        assert.equal(state.persistenceSynchronized, false)
        assert.equal(state.lastCompaction, 0)

        await assert.rejects(
            mapTool.execute({} as any, createToolContext(sessionId, "map-after-cleanup-failure") as any),
            /could not load saved session state/,
        )
        assert.deepEqual(state.compressionMapSnapshot, originalSnapshot)
        assert.equal(state.persistenceSynchronized, false)

        await assert.rejects(
            compressTool.execute(
                { from: 1, to: 1, topic: "Stale", summary: "Must not run." },
                createToolContext(sessionId, "compress-after-cleanup-failure") as any,
            ),
            /cannot trust saved session state/,
        )
    })

    it("retries a failed missing-trigger compaction reset without advancing authority", async () => {
        const nestedSessionRoot = `session-compress-map-compaction-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const sessionId = `${nestedSessionRoot}/state`
        const sessionFile = getSessionFilePath(sessionId)
        const sessionDirectory = dirname(sessionFile)
        await rm(sessionDirectory, { recursive: true, force: true })

        const oldMessage = textMessage("old-message", sessionId, "Pre-compaction history")
        const oldTrigger = textMessage("old-manage-trigger", sessionId, "Manage")
        const compaction = {
            ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant"),
            info: {
                ...textMessage("native-compaction", sessionId, "Native compacted context", "assistant").info,
                summary: true,
                time: { created: Date.now() + 1 },
            },
        }
        const messages = [
            compaction,
            textMessage("post-compaction-user", sessionId, "Continue after compaction"),
        ]
        let saveFailureCount = 0
        const countingLogger = {
            ...logger,
            error: (message: string) => {
                if (message === "Failed to save session state") saveFailureCount++
            },
        } as any
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.compressed.messageIds = new Set([oldMessage.info.id])
        state.compressSummaries = [
            {
                anchorMessageId: oldMessage.info.id,
                messageIds: [oldMessage.info.id],
                summary: "Pre-compaction plugin summary.",
            },
        ]
        state.managementTurns = [{ triggerMessageId: oldTrigger.info.id }]
        pinCompressionMap(state, [oldMessage, oldTrigger], {
            triggerMessageId: oldTrigger.info.id,
            reuseExistingTurn: true,
        })
        state.initialized = false
        const originalSnapshot = structuredClone(state.compressionMapSnapshot)
        const handler = createChatMessageTransformHandler(
            { session: { get: async () => ({ data: {} }) } },
            stateManager,
            countingLogger,
            config,
        )

        try {
            await handler({}, { messages: structuredClone(messages) as any })
            await handler({}, { messages: structuredClone(messages) as any })

            assert.equal(saveFailureCount, 2)
            assert.equal(state.persistenceSynchronized, false)
            assert.equal(state.lastCompaction, 0)
            assert.deepEqual(state.compressionMapSnapshot, originalSnapshot)
            assert.equal(state.compressed.messageIds.has(oldMessage.info.id), true)
            assert.equal(state.managementTurns.length, 1)

            await mkdir(sessionDirectory, { recursive: true })
            await handler({}, { messages: structuredClone(messages) as any })

            assert.equal(state.persistenceSynchronized, true)
            assert.equal(state.lastCompaction, compaction.info.time.created)
            assert.equal(state.compressionMapSnapshot, undefined)
            assert.equal(state.compressed.messageIds.size, 0)
            assert.deepEqual(state.compressSummaries, [])
            assert.deepEqual(state.managementTurns, [])
        } finally {
            await rm(join(
                process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
                "opencode",
                "storage",
                "plugin",
                "compress",
                nestedSessionRoot,
            ), { recursive: true, force: true })
        }
    })

    it("compress_map pins the current map shape without marking its output for stripping", async () => {
        const sessionId = `session-compress-map-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                textMessage("m1", sessionId, "Phase one request"),
                textMessage("m2", sessionId, "Phase one result", "assistant"),
                textMessage("m3", sessionId, "Phase two request"),
                textMessage("manage-trigger", sessionId, "Manage compression"),
            ]
            const stateManager = new SessionStateManager()
            const state = stateManager.get(sessionId)
            state.sessionId = sessionId
            state.initialized = true
            state.managementTurns = [{ triggerMessageId: "manage-trigger" }]
            pinCompressionMap(state, rawMessages, {
                triggerMessageId: "manage-trigger",
                reuseExistingTurn: true,
            })

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
            assert.equal(state.compressionMapSnapshot?.triggerMessageId, "manage-trigger")
            assert.equal(state.compressionMapSnapshot?.entries.length, 3)
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
                textMessage("manage-reasoning", sessionId, "Choosing a range", "assistant"),
                toolMessage("manage-failed-compress", sessionId, "compress", "Unknown range end"),
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
            assert.doesNotMatch(output, /Choosing a range/)
            assert.doesNotMatch(output, /Unknown range end/)
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
            pinCompressionMap(state, rawMessages, {
                triggerMessageId: "manage-trigger",
                reuseExistingTurn: true,
            })

            const tool = createCompressTool({
                client: createClient(rawMessages),
                stateManager,
                logger,
                config,
                workingDirectory: "/tmp",
            })

            await assert.rejects(
                tool.execute(
                    { from: 1, to: 99, topic: "Invalid", summary: "Must not store." },
                    createToolContext(sessionId, "call-invalid-range") as any,
                ),
                /Unknown range end: 99.*Nothing was compressed.*Do not guess.*Available: numeric boundaries 1 through 2/s,
            )
            assert.ok(state.compressionMapSnapshot)

            const output = await tool.execute(
                { from: 1, to: 2, topic: "Prior Work", summary: "Summary of prior work." },
                createToolContext(sessionId, "call-manage-compress-1") as any,
            )

            assert.match(output, /Stored \[b0\] "Prior Work" durably; the fold is already in effect/)
            assert.match(output, /Do not call compress or compress_map again this turn/)
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

    it("allows a normal map but blocks normal compression during cooldown before asking permission", async () => {
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
            textMessage("current-user", sessionId, "Inspect context"),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.compressionCooldownAfterMessageId = "compress-anchor"
        let askCalls = 0
        const mapTool = createCompressMapTool({
            client: createClient(rawMessages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
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

        await mapTool.execute({} as any, createToolContext(sessionId, "cooldown-map") as any)
        assert.equal(state.compressionMapSnapshot?.source, "normal")
        assert.equal(state.compressionMapSnapshot?.cooldownRemaining, 2)

        await assert.rejects(
            tool.execute(
                { from: 1, to: 1, topic: "Blocked", summary: "Must not be stored." },
                toolContext as any,
            ),
            /Wait 2 more assistant responses.*refresh with compress_map.*`\/compress manage`/is,
        )
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
                /cannot trust saved session state/,
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
        pinCompressionMap(state, rawMessages, {
            triggerMessageId: "manual-trigger",
            reuseExistingTurn: true,
        })
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

    it("does not create an automatic execution pin while the successful-compression cooldown applies", async () => {
        const sessionId = `session-compress-map-auto-cooldown-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const completed = (message: any) => ({
            ...message,
            info: {
                ...message.info,
                time: { created: Date.now(), completed: Date.now() },
            },
        })
        const rawMessages = [
            completed(toolMessage("compress-anchor", sessionId, "compress", "done")),
            textMessage("normal-user", sessionId, "Continue"),
            completed(textMessage("normal-assistant", sessionId, "Progress", "assistant")),
            textMessage("auto-trigger", sessionId, "Automatic management"),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.compressionCooldownAfterMessageId = "compress-anchor"
        state.managementTurns = [
            { triggerMessageId: "auto-trigger", source: "automatic" },
        ]
        const mapTool = createCompressMapTool({
            client: createClient(rawMessages),
            stateManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })

        try {
            await assert.rejects(
                mapTool.execute({} as any, createToolContext(sessionId, "auto-cooldown-map") as any),
                /still in its post-compression cooldown.*No new map became authoritative/s,
            )
            assert.equal(state.compressionMapSnapshot, undefined)
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
            pinCompressionMap(state, rawMessages, {
                triggerMessageId: "auto-trigger",
                source: "automatic",
                protectedMessageIds: ["m2"],
                reuseExistingTurn: true,
            })

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

            assert.match(output, /^Compression complete\. Stored \[b0\] "Older Work" durably/)
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
            pinCompressionMap(state, rawMessages, {
                triggerMessageId: "manage-trigger",
                reuseExistingTurn: true,
            })

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
        const baselineStats = { ...state.stats }
        pinCompressionMap(state, rawMessages)
        const baselineManagementTurns = [...state.managementTurns]
        const baselineSnapshot = state.compressionMapSnapshot

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
        assert.deepEqual(state.compressionMapSnapshot, baselineSnapshot)
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
        pinCompressionMap(state, rawMessages)
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
                messages: async () => {
                    messageReads++
                    return { data: [...latestMessages] }
                },
                promptAsync: async () => {
                    promptCalls++
                    return { data: undefined }
                },
            },
        }
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        pinCompressionMap(state, oldMessages)
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
        pinCompressionMap(state, rawMessages)
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
            assert.equal(state.managementTurns.length, 2)

            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.compressSummaries.length, 1)
            assert.equal(
                loaded.state.compressionCooldownAfterMessageId,
                "message-manage-overlap",
            )
            assert.equal(loaded.state.managementTurns.length, 2)
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
            pinCompressionMap(state, rawMessages, {
                triggerMessageId: state.managementTurns[0].triggerMessageId,
                reuseExistingTurn: true,
            })

            const compression = await tool.execute(
                {
                    from: "1-2",
                    to: "1-2",
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

            pinCompressionMap(state, rawMessages)
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
            assert.match(firstOutput, /Stored \[b0\] "Phase A" durably/)

            pinCompressionMap(state, rawMessages)
            const secondOutput = await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase B",
                    summary: "Higher-fidelity summary for phase B.",
                },
                createToolContext(sessionId, "call-compress-2") as any,
            )

            assert.match(secondOutput, /Stored \[b1\] "Phase B" durably/)

            pinCompressionMap(state, rawMessages)
            const thirdOutput = await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase C",
                    summary: "Steady summary for phase C.",
                },
                createToolContext(sessionId, "call-compress-3") as any,
            )

            assert.match(thirdOutput, /Stored \[b2\] "Phase C" durably/)

            pinCompressionMap(state, rawMessages)
            const fourthOutput = await tool.execute(
                {
                    from: "b1",
                    to: "b1",
                    topic: "Phase B Updated",
                    summary: "Much terser updated summary for phase B.",
                },
                createToolContext(sessionId, "call-compress-4") as any,
            )

            assert.match(fourthOutput, /Stored \[b1\] "Phase B Updated" durably/)
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

            pinCompressionMap(state, rawMessages)
            await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Older Phase",
                    summary: "Detailed older-phase summary.",
                },
                createToolContext(sessionId, "call-compress-a") as any,
            )

            pinCompressionMap(state, rawMessages)
            const secondOutput = await tool.execute(
                {
                    from: "b0",
                    to: "b0",
                    topic: "Older Phase Condensed",
                    summary: "Much terser condensed summary.",
                },
                createToolContext(sessionId, "call-compress-b") as any,
            )

            assert.match(secondOutput, /Stored \[b0\] "Older Phase Condensed" durably/)
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

            pinCompressionMap(state, rawMessages)
            await tool.execute(
                {
                    from: 1,
                    to: 2,
                    topic: "Phase A",
                    summary: "Stored summary for phase A.",
                },
                createToolContext(sessionId, "call-compress-mixed-1") as any,
            )

            pinCompressionMap(state, rawMessages)
            const secondOutput = await tool.execute(
                {
                    from: "b0",
                    to: 2,
                    topic: "Combined A+B",
                    summary: "Fresh summary for the new phase B work.",
                },
                createToolContext(sessionId, "call-compress-mixed-2") as any,
            )

            assert.match(secondOutput, /Stored \[b0\] "Combined A\+B" durably/)
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
