import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { PluginConfig } from "../lib/config.ts"
import { extractSquashCommandResidual, handleSquashCommand } from "../lib/commands/squash.ts"
import { applyCompressTransforms } from "../lib/messages/compress-transform.ts"
import { formatCompressBlockContent, orderCompressBlocks } from "../lib/messages/blocks.ts"
import { loadSessionState } from "../lib/state/persistence.ts"
import { createSessionState, SessionStateManager } from "../lib/state/state.ts"
import { estimateTokensBatch } from "../lib/token-utils.ts"
import { createCompressTool } from "../lib/tools/compress.ts"
import { createSquashTool } from "../lib/tools/squash.ts"

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
    protectedTurns: 3,
    commands: { enabled: true, protectedTools: [] },
    autoCompression: {
        enabled: true,
        contextWindowRatio: 0.9,
        tokenThreshold: 300_000,
    },
    turnProtection: { enabled: false, turns: 0 },
    protectedFilePatterns: [],
    tools: {
        settings: { protectedTools: [] },
        compress: { permission: "allow", showCompression: false },
    },
}

function textMessage(
    id: string,
    sessionID: string,
    role: "user" | "assistant" = "user",
    text = id,
) {
    return {
        info: {
            id,
            role,
            sessionID,
            ...(role === "user"
                ? {
                      agent: "agent-test",
                      model: { providerID: "openai", modelID: "gpt-5.4" },
                  }
                : {}),
            time: { created: Date.now() },
        },
        parts: [{ type: "text", text }],
    } as any
}

function squashCallMessage(id: string, sessionID: string, parentID: string, callID: string) {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            parentID,
            time: { created: Date.now() },
        },
        parts: [
            {
                type: "tool",
                tool: "squash",
                callID,
                state: {
                    status: "running",
                    input: {},
                },
            },
        ],
    } as any
}

function completedToolMessage(id: string, sessionID: string, callID: string, output: string) {
    return {
        info: { id, role: "assistant", sessionID, time: { created: Date.now() } },
        parts: [
            {
                type: "tool",
                tool: "read",
                callID,
                state: { status: "completed", input: { filePath: "/tmp/example" }, output },
            },
        ],
    } as any
}

function compressCallMessage(id: string, sessionID: string, parentID: string, callID: string) {
    return {
        ...squashCallMessage(id, sessionID, parentID, callID),
        parts: [
            {
                type: "tool",
                tool: "compress",
                callID,
                state: { status: "running", input: {} },
            },
        ],
    } as any
}

function toolContext(sessionID: string, messageID: string, callID: string, ask = async (_input: any) => {}) {
    return {
        sessionID,
        messageID,
        callID,
        agent: "agent-test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask,
    } as any
}

function client(messages: any[]) {
    return {
        session: {
            get: async () => ({ data: {} }),
            messages: async () => ({ data: messages }),
        },
    }
}

function sessionFile(sessionId: string) {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "compress",
        `${sessionId}.json`,
    )
}

async function cleanup(sessionId: string) {
    const path = sessionFile(sessionId)
    if (existsSync(path)) await rm(path)
}

function durableSnapshot(state: ReturnType<SessionStateManager["get"]>) {
    return {
        compressed: {
            messageIds: [...state.compressed.messageIds],
            toolIds: [...state.compressed.toolIds],
        },
        compressSummaries: structuredClone(state.compressSummaries),
        managementTurns: structuredClone(state.managementTurns),
        stats: { ...state.stats },
        cooldown: state.compressionCooldownAfterMessageId,
    }
}

function seedBlocks(
    state: ReturnType<SessionStateManager["get"]>,
    sessionId: string,
    count: number,
) {
    const messages: any[] = []
    const summaries: any[] = []
    for (let index = 0; index < count; index++) {
        const anchor = `block-${index}-user`
        const detail = `block-${index}-assistant`
        messages.push(textMessage(anchor, sessionId, "user", `Original ${index}`))
        messages.push(textMessage(detail, sessionId, "assistant", `Answer ${index}`))
        state.compressed.messageIds.add(anchor)
        state.compressed.messageIds.add(detail)
        summaries.push({
            anchorMessageId: anchor,
            messageIds: [anchor, detail],
            summary: `Block ${index} chronology ${"detail ".repeat(20)}`,
            topic: `Topic ${index}`,
        })
    }
    state.compressSummaries = [...summaries].reverse()
    return { messages, summaries }
}

async function executeSquashRange(from: number, to: number, count = 5) {
    const sessionId = `squash-range-${from}-${to}-${Date.now()}-${Math.random()}`
    const manager = new SessionStateManager()
    const state = manager.get(sessionId)
    state.initialized = true
    const seeded = seedBlocks(state, sessionId, count)
    state.compressed.toolIds.add("old-tool")
    state.stats = { compressTokenCounter: 91, totalCompressTokens: 700 }
    state.compressionCooldownAfterMessageId = "existing-cooldown"
    const trigger = textMessage("squash-trigger", sessionId, "user", "/compress squash")
    state.managementTurns = [{ triggerMessageId: trigger.info.id, source: "squash" }]
    const call = squashCallMessage("squash-call", sessionId, trigger.info.id, "call-squash")
    const uncompressed = textMessage("visible-uncompressed", sessionId, "assistant", "Keep me visible")
    uncompressed.parts.unshift({ type: "step-start" })
    const visibleTool = completedToolMessage(
        "visible-tool-message",
        sessionId,
        "visible-tool-call",
        "Keep this tool output literal",
    )
    const messages = [...seeded.messages, uncompressed, visibleTool, trigger, call]
    let permission: string | undefined
    const tool = createSquashTool({
        client: client(messages),
        stateManager: manager,
        logger,
        config,
        workingDirectory: "/tmp",
    })
    const replacementSummary = `Replacement ${from}-${to}`
    const receipt = await tool.execute(
        {
            from: `b${from}`,
            to: `b${to}`,
            summary: replacementSummary,
            topic: "Replacement Topic",
        },
        toolContext(sessionId, call.info.id, "call-squash", async (input) => {
            permission = input.permission
        }),
    )
    return {
        sessionId,
        manager,
        state,
        messages,
        seeded,
        receipt,
        permission,
        replacementSummary,
    }
}

describe("squash command", () => {
    it("opens a durable squash-owned turn with a separate retained user instruction", async () => {
        const sessionId = `squash-command-${Date.now()}-${Math.random()}`
        await cleanup(sessionId)
        const manager = new SessionStateManager()
        const state = manager.get(sessionId)
        state.initialized = true
        state.persistenceSynchronized = true
        const seeded = seedBlocks(state, sessionId, 2)
        let promptBody: any
        const commandClient = {
            session: {
                prompt: async (input: any) => {
                    promptBody = input.body
                    return { data: { info: { id: "assistant", parentID: input.body.messageID } } }
                },
            },
        }

        try {
            await handleSquashCommand({
                client: commandClient,
                stateManager: manager,
                state,
                config,
                logger,
                sessionId,
                messages: seeded.messages,
                arguments: "squash keep the first milestone intact",
            })

            assert.equal(state.managementTurns.length, 1)
            assert.equal(state.managementTurns[0].source, "squash")
            assert.equal(state.managementTurns[0].retainedText, "keep the first milestone intact")
            assert.match(promptBody.parts[0].text, /CONTEXT SQUASH REQUESTED/)
            assert.equal(
                promptBody.parts[1].text,
                "<user-message>\nkeep the first milestone intact\n</user-message>",
            )

            const reloaded = await loadSessionState(sessionId, logger, seeded.messages)
            assert.equal(reloaded.status, "loaded")
            if (reloaded.status === "loaded") {
                assert.equal(reloaded.state.managementTurns[0].source, "squash")
            }
        } finally {
            await cleanup(sessionId)
        }
    })

    it("refuses denied, unsynchronized, too-small, active, and ambiguous command starts", async () => {
        const cases = ["denied", "unsynchronized", "too-small", "active", "ambiguous"] as const
        for (const scenario of cases) {
            const sessionId = `squash-command-${scenario}-${Date.now()}-${Math.random()}`
            const manager = new SessionStateManager()
            const state = manager.get(sessionId)
            state.initialized = true
            state.persistenceSynchronized = scenario !== "unsynchronized"
            const seeded = seedBlocks(state, sessionId, scenario === "too-small" ? 1 : 2)
            const messages = [...seeded.messages]
            if (scenario === "active") {
                const active = textMessage("active-manage", sessionId, "user", "/compress manage")
                messages.push(active)
                state.managementTurns = [{ triggerMessageId: active.info.id }]
            }
            if (scenario === "ambiguous") {
                state.compressSummaries[1].anchorMessageId = state.compressSummaries[0].anchorMessageId
            }
            const toasts: any[] = []
            let promptCalls = 0
            const commandClient = {
                tui: { showToast: async (input: any) => toasts.push(input) },
                session: { prompt: async () => { promptCalls++ } },
            }
            const commandConfig = scenario === "denied"
                ? {
                      ...config,
                      tools: {
                          ...config.tools,
                          compress: { ...config.tools.compress, permission: "deny" as const },
                      },
                  }
                : config

            await handleSquashCommand({
                client: commandClient,
                stateManager: manager,
                state,
                config: commandConfig,
                logger,
                sessionId,
                messages,
                arguments: "squash",
            })

            assert.equal(promptCalls, 0, scenario)
            assert.equal(state.managementTurns.length, scenario === "active" ? 1 : 0, scenario)
            assert.equal(toasts.length, 1, scenario)
            await cleanup(sessionId)
        }
    })

    it("leaves state unchanged when the open-turn marker cannot be persisted", async () => {
        const sessionId = `missing-parent/${Date.now()}`
        const manager = new SessionStateManager()
        const state = manager.get(sessionId)
        state.initialized = true
        state.persistenceSynchronized = true
        const seeded = seedBlocks(state, sessionId, 2)
        const before = durableSnapshot(state)
        const toasts: any[] = []
        let promptCalls = 0

        await handleSquashCommand({
            client: {
                tui: { showToast: async (input: any) => toasts.push(input) },
                session: { prompt: async () => { promptCalls++ } },
            },
            stateManager: manager,
            state,
            config,
            logger,
            sessionId,
            messages: seeded.messages,
            arguments: "squash",
        })

        assert.equal(promptCalls, 0)
        assert.equal(toasts.length, 1)
        assert.deepEqual(durableSnapshot(state), before)
    })

    it("preserves all trailing command text as the squash instruction", () => {
        assert.equal(extractSquashCommandResidual("squash"), undefined)
        assert.equal(
            extractSquashCommandResidual("squash: keep b0 separate and condense the verbose middle"),
            "keep b0 separate and condense the verbose middle",
        )
    })
})

describe("squash tool", () => {
    it("has a separate four-argument schema while compress remains byte-compatible", () => {
        const context = {
            client: client([]),
            stateManager: new SessionStateManager(),
            logger,
            config,
            workingDirectory: "/tmp",
        }
        assert.deepEqual(Object.keys((createCompressTool(context) as any).args), ["summary", "topic"])
        assert.deepEqual(Object.keys((createSquashTool(context) as any).args), [
            "from",
            "to",
            "summary",
            "topic",
        ])
    })

    it("replaces b1 through b12 in a 20-block session and relabels canonically", async () => {
        const result = await executeSquashRange(1, 12, 20)
        try {
            assert.equal(result.permission, "compress")
            assert.match(result.receipt, /Replaced \[b1\]-\[b12\] with \[b1\]/)
            assert.match(result.receipt, /Uncompressed history was untouched/)
            assert.equal(result.state.compressSummaries.length, 9)
            assert.deepEqual(
                result.state.compressSummaries.map((summary) => summary.anchorMessageId),
                [
                    "block-0-user",
                    "block-1-user",
                    "block-13-user",
                    "block-14-user",
                    "block-15-user",
                    "block-16-user",
                    "block-17-user",
                    "block-18-user",
                    "block-19-user",
                ],
            )
            assert.deepEqual(result.state.compressSummaries[0], result.seeded.summaries[0])
            for (let oldIndex = 13; oldIndex < 20; oldIndex++) {
                assert.deepEqual(
                    result.state.compressSummaries[oldIndex - 11],
                    result.seeded.summaries[oldIndex],
                )
            }
            assert.deepEqual(
                result.state.compressSummaries[1].messageIds,
                Array.from({ length: 12 }, (_, offset) => [
                    `block-${offset + 1}-user`,
                    `block-${offset + 1}-assistant`,
                ]).flat(),
            )
            assert.equal(result.state.managementTurns[0].completedMessageId, "squash-call")
            assert.equal(result.state.compressionCooldownAfterMessageId, "existing-cooldown")
            assert.deepEqual([...result.state.compressed.toolIds], ["old-tool"])
            assert.equal(result.state.compressed.messageIds.size, 40)

            const transformed = structuredClone(result.messages)
            applyCompressTransforms(result.state, logger, transformed)
            const blockTexts = transformed
                .map((message: any) => message.parts[0]?.text)
                .filter((text: unknown): text is string =>
                    typeof text === "string" && text.startsWith("[Compressed conversation block]"),
                )
            assert.deepEqual(
                blockTexts.map((text) => text.match(/\[(b\d+)\]/)?.[1]),
                ["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"],
            )
            assert.equal(transformed.some((message: any) => message.info.id === "visible-uncompressed"), true)
            const visibleTool = transformed.find((message: any) => message.info.id === "visible-tool-message")
            assert.equal(visibleTool?.parts[0].state.output, "Keep this tool output literal")
            assert.equal(transformed.some((message: any) => message.info.id === "squash-trigger"), false)
            assert.equal(transformed.some((message: any) => message.info.id === "squash-call"), true)

            const laterMessages = [
                ...structuredClone(result.messages),
                textMessage("later-user", result.sessionId, "user", "Continue normally"),
            ]
            applyCompressTransforms(result.state, logger, laterMessages)
            assert.equal(laterMessages.some((message: any) => message.info.id === "squash-trigger"), false)
            assert.equal(laterMessages.some((message: any) => message.info.id === "squash-call"), false)
            assert.equal(laterMessages.some((message: any) => message.info.id === "later-user"), true)

            const reloaded = await loadSessionState(result.sessionId, logger, result.messages)
            assert.equal(reloaded.status, "loaded")
            if (reloaded.status === "loaded") {
                assert.deepEqual(reloaded.state.compressSummaries, result.state.compressSummaries)
                assert.equal(reloaded.state.managementTurns[0].source, "squash")
                assert.equal(reloaded.state.managementTurns[0].completedMessageId, "squash-call")
            }
        } finally {
            await cleanup(result.sessionId)
        }
    })

    for (const [name, from, to, count] of [
        ["oldest", 0, 1, 5],
        ["newest", 3, 4, 5],
        ["two-block middle", 1, 2, 4],
    ] as const) {
        it(`supports a valid ${name} range`, async () => {
            const result = await executeSquashRange(from, to, count)
            try {
                assert.equal(result.state.compressSummaries.length, count - (to - from))
                assert.equal(result.state.compressSummaries[from].summary, result.replacementSummary)
                assert.match(result.receipt, new RegExp(`Replaced \\[b${from}\\]-\\[b${to}\\]`))
            } finally {
                await cleanup(result.sessionId)
            }
        })
    }

    it("adds only positive visible-summary token savings and resets the counter", async () => {
        const result = await executeSquashRange(1, 2, 4)
        try {
            const oldBlocks = orderCompressBlocks(result.messages, result.seeded.summaries).slice(1, 3)
            const replacement = result.state.compressSummaries[1]
            const expected = Math.max(
                0,
                estimateTokensBatch(oldBlocks.map(formatCompressBlockContent), "openai") -
                    estimateTokensBatch(
                        [formatCompressBlockContent({ label: "b1", summary: replacement })],
                        "openai",
                    ),
            )
            assert.equal(result.state.stats.totalCompressTokens, 700 + expected)
            assert.equal(result.state.stats.compressTokenCounter, 0)
            assert.ok(expected > 0)
        } finally {
            await cleanup(result.sessionId)
        }
    })

    it("does not subtract stats when the replacement is longer than the selected summaries", async () => {
        const sessionId = `squash-negative-saving-${Date.now()}-${Math.random()}`
        const manager = new SessionStateManager()
        const state = manager.get(sessionId)
        state.initialized = true
        const seeded = seedBlocks(state, sessionId, 2)
        state.compressSummaries.forEach((summary) => { summary.summary = "short" })
        state.stats = { compressTokenCounter: 4, totalCompressTokens: 25 }
        const trigger = textMessage("trigger", sessionId, "user")
        state.managementTurns = [{ triggerMessageId: "trigger", source: "squash" }]
        const call = squashCallMessage("call-message", sessionId, "trigger", "call")
        const messages = [...seeded.messages, trigger, call]
        const tool = createSquashTool({ client: client(messages), stateManager: manager, logger, config, workingDirectory: "/tmp" })

        try {
            await tool.execute(
                { from: "b0", to: "b1", summary: "long ".repeat(500), topic: "Long" },
                toolContext(sessionId, "call-message", "call"),
            )
            assert.equal(state.stats.totalCompressTokens, 25)
            assert.equal(state.stats.compressTokenCounter, 0)
        } finally {
            await cleanup(sessionId)
        }
    })

    it("rejects unauthorized, stale, malformed, reversed, one-block, missing, and ambiguous calls without state changes", async () => {
        const scenarios = [
            { name: "unauthorized", from: "b0", to: "b1" },
            { name: "stale", from: "b0", to: "b1" },
            { name: "malformed", from: "0", to: "b1" },
            { name: "reversed", from: "b1", to: "b0" },
            { name: "one-block", from: "b0", to: "b0" },
            { name: "missing", from: "b0", to: "b9" },
            { name: "ambiguous", from: "b0", to: "b1" },
            { name: "unreconcilable", from: "b0", to: "b1" },
        ] as const

        for (const scenario of scenarios) {
            const sessionId = `squash-invalid-${scenario.name}-${Date.now()}-${Math.random()}`
            const manager = new SessionStateManager()
            const state = manager.get(sessionId)
            state.initialized = true
            const seeded = seedBlocks(state, sessionId, 2)
            const trigger = textMessage("trigger", sessionId, "user")
            if (scenario.name !== "unauthorized") {
                state.managementTurns = [{ triggerMessageId: "trigger", source: "squash" }]
            }
            if (scenario.name === "ambiguous") {
                state.compressSummaries[1].anchorMessageId = state.compressSummaries[0].anchorMessageId
            }
            if (scenario.name === "unreconcilable") {
                state.compressSummaries[1].anchorMessageId = "missing-anchor"
            }
            const call = squashCallMessage("call-message", sessionId, "trigger", "call")
            const messages = [...seeded.messages, trigger]
            if (scenario.name === "stale") messages.push(textMessage("later-user", sessionId, "user"))
            messages.push(call)
            const before = durableSnapshot(state)
            let asked = false
            const tool = createSquashTool({ client: client(messages), stateManager: manager, logger, config, workingDirectory: "/tmp" })

            await assert.rejects(
                tool.execute(
                    {
                        from: scenario.from,
                        to: scenario.to,
                        summary: "Unused",
                        topic: "Unused",
                    },
                    toolContext(sessionId, "call-message", "call", async () => { asked = true }),
                ),
            )
            assert.equal(asked, false, scenario.name)
            assert.deepEqual(durableSnapshot(state), before, scenario.name)
            assert.equal(existsSync(sessionFile(sessionId)), false, scenario.name)
        }
    })

    it("rejects absent or blank required values before permission or persistence", async () => {
        const manager = new SessionStateManager()
        const tool = createSquashTool({
            client: client([]),
            stateManager: manager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        for (const input of [
            { from: undefined, to: "b1", summary: "Summary", topic: "Topic" },
            { from: "b0", to: undefined, summary: "Summary", topic: "Topic" },
            { from: "b0", to: "b1", summary: "   ", topic: "Topic" },
            { from: "b0", to: "b1", summary: "Summary", topic: "   " },
        ]) {
            await assert.rejects(
                tool.execute(input as any, toolContext("blank-squash", "message", "call")),
                /squash requires/,
            )
        }
        assert.deepEqual(manager.get("blank-squash").compressSummaries, [])
    })

    it("keeps live state unchanged when persistence fails", async () => {
        const sessionId = `missing-parent/${Date.now()}`
        const manager = new SessionStateManager()
        const state = manager.get(sessionId)
        state.initialized = true
        const seeded = seedBlocks(state, sessionId, 2)
        const trigger = textMessage("trigger", sessionId, "user")
        state.managementTurns = [{ triggerMessageId: "trigger", source: "squash" }]
        const call = squashCallMessage("call-message", sessionId, "trigger", "call")
        const messages = [...seeded.messages, trigger, call]
        const before = durableSnapshot(state)
        const tool = createSquashTool({ client: client(messages), stateManager: manager, logger, config, workingDirectory: "/tmp" })

        await assert.rejects(
            tool.execute(
                { from: "b0", to: "b1", summary: "Replacement", topic: "Replacement" },
                toolContext(sessionId, "call-message", "call"),
            ),
            /could not persist compression state/,
        )
        assert.deepEqual(durableSnapshot(state), before)
    })

    it("keeps state unchanged when permission is rejected or transcript fetch fails", async () => {
        const permissionSession = `squash-permission-${Date.now()}-${Math.random()}`
        const permissionManager = new SessionStateManager()
        const permissionState = permissionManager.get(permissionSession)
        permissionState.initialized = true
        const seeded = seedBlocks(permissionState, permissionSession, 2)
        const trigger = textMessage("trigger", permissionSession, "user")
        permissionState.managementTurns = [{ triggerMessageId: "trigger", source: "squash" }]
        const call = squashCallMessage("call-message", permissionSession, "trigger", "call")
        const beforePermission = durableSnapshot(permissionState)
        const permissionTool = createSquashTool({
            client: client([...seeded.messages, trigger, call]),
            stateManager: permissionManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        await assert.rejects(
            permissionTool.execute(
                { from: "b0", to: "b1", summary: "Replacement", topic: "Replacement" },
                toolContext(permissionSession, "call-message", "call", async () => {
                    throw new Error("denied")
                }),
            ),
            /denied/,
        )
        assert.deepEqual(durableSnapshot(permissionState), beforePermission)
        assert.equal(existsSync(sessionFile(permissionSession)), false)

        const fetchSession = `squash-fetch-${Date.now()}-${Math.random()}`
        const fetchManager = new SessionStateManager()
        const fetchState = fetchManager.get(fetchSession)
        fetchState.initialized = true
        const beforeFetch = durableSnapshot(fetchState)
        const fetchTool = createSquashTool({
            client: {
                session: {
                    get: async () => ({ data: {} }),
                    messages: async () => { throw new Error("offline") },
                },
            },
            stateManager: fetchManager,
            logger,
            config,
            workingDirectory: "/tmp",
        })
        await assert.rejects(
            fetchTool.execute(
                { from: "b0", to: "b1", summary: "Replacement", topic: "Replacement" },
                toolContext(fetchSession, "call-message", "call"),
            ),
            /could not fetch session messages: offline/,
        )
        assert.deepEqual(durableSnapshot(fetchState), beforeFetch)
    })

    it("prevents compress from consuming a squash-owned management turn", async () => {
        const sessionId = `compress-during-squash-${Date.now()}-${Math.random()}`
        const manager = new SessionStateManager()
        const state = manager.get(sessionId)
        state.initialized = true
        const seeded = seedBlocks(state, sessionId, 2)
        const trigger = textMessage("trigger", sessionId, "user")
        state.managementTurns = [{ triggerMessageId: "trigger", source: "squash" }]
        const call = compressCallMessage("compress-call", sessionId, "trigger", "call")
        const messages = [...seeded.messages, trigger, call]
        const before = durableSnapshot(state)
        const tool = createCompressTool({ client: client(messages), stateManager: manager, logger, config, workingDirectory: "/tmp" })

        await assert.rejects(
            tool.execute(
                { summary: "Wrong tool", topic: "Wrong" },
                toolContext(sessionId, "compress-call", "call"),
            ),
            /cannot complete an active `\/compress squash` turn/,
        )
        assert.deepEqual(durableSnapshot(state), before)
    })
})
