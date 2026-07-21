import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { PluginConfig } from "../lib/config.ts"
import { applyCompressTransforms } from "../lib/messages/compress-transform.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import { createCompressTool, resolveCompressionBoundary } from "../lib/tools/compress.ts"

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    saveContext: async () => {},
} as any

const baseConfig: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "off",
    notificationType: "chat",
    protectedTurns: 0,
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
    role: "user" | "assistant",
    options: { parentID?: string; stepStart?: boolean } = {},
) {
    return {
        info: {
            id,
            role,
            sessionID,
            ...(options.parentID ? { parentID: options.parentID } : {}),
            time: { created: Date.now(), ...(role === "assistant" ? { completed: Date.now() } : {}) },
        },
        parts: [
            ...(options.stepStart ? [{ type: "step-start" }] : []),
            { type: "text", text: id },
        ],
    } as any
}

function compressCallMessage(
    id: string,
    sessionID: string,
    parentID: string,
    callID: string,
) {
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
                tool: "compress",
                callID,
                state: { status: "running", input: {} },
            },
        ],
    } as any
}

function toolContext(sessionID: string, messageID: string, callID: string, ask = async () => {}) {
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

async function executePath(
    source: "normal" | "manual" | "automatic",
    protectedTurns = 0,
) {
    const sessionId = `single-tool-${source}-${Date.now()}-${Math.random()}`
    const callID = `call-${source}`
    const old = [
        textMessage("old-user", sessionId, "user"),
        textMessage("old-step", sessionId, "assistant", { stepStart: true }),
        textMessage("recent-user", sessionId, "user"),
        textMessage("recent-step", sessionId, "assistant", { stepStart: true }),
    ]
    let owner = textMessage("current-user", sessionId, "user")
    let messages: any[]
    const stateManager = new SessionStateManager()
    const state = stateManager.get(sessionId)
    state.initialized = true
    if (source === "normal") {
        messages = [...old, owner]
    } else {
        owner = textMessage("manage-trigger", sessionId, "user")
        state.managementTurns = [
            {
                triggerMessageId: owner.info.id,
                ...(source === "automatic" ? { source: "automatic" as const } : {}),
            },
        ]
        messages = [...old, owner]
    }
    const current = compressCallMessage("compress-message", sessionId, owner.info.id, callID)
    messages.push(current)

    const tool = createCompressTool({
        client: client(messages),
        stateManager,
        logger,
        config: { ...baseConfig, protectedTurns },
        workingDirectory: "/tmp",
    })
    const receipt = await tool.execute(
        { summary: `${source} summary`, topic: `${source} topic` },
        toolContext(sessionId, current.info.id, callID),
    )
    return { sessionId, receipt, state, messages }
}

describe("single-tool compression", () => {
    it("accepts only summary and topic in the public schema", () => {
        const tool = createCompressTool({
            client: client([]),
            stateManager: new SessionStateManager(),
            logger,
            config: baseConfig,
            workingDirectory: "/tmp",
        }) as any

        assert.deepEqual(Object.keys(tool.args), ["summary", "topic"])
    })

    it("rejects blank summary or topic values before changing state", async () => {
        const sessionId = "blank-arguments"
        const stateManager = new SessionStateManager()
        const tool = createCompressTool({
            client: client([]),
            stateManager,
            logger,
            config: baseConfig,
            workingDirectory: "/tmp",
        })

        await assert.rejects(
            tool.execute(
                { summary: "   ", topic: "Topic" },
                toolContext(sessionId, "message", "call"),
            ),
            /non-empty summary/,
        )
        await assert.rejects(
            tool.execute(
                { summary: "Summary", topic: "   " },
                toolContext(sessionId, "message", "call"),
            ),
            /non-empty topic/,
        )
        assert.deepEqual(stateManager.get(sessionId).compressSummaries, [])
    })

    for (const source of ["normal", "manual", "automatic"] as const) {
        it(`${source} compression selects the full eligible history in one call`, async () => {
            const result = await executePath(source)
            try {
                assert.match(result.receipt, /fold is already in effect/)
                if (source === "automatic") {
                    assert.match(result.receipt, /Automatic compression finished.*Continue the original work now/i)
                    assert.match(result.receipt, /already complete or awaiting the user/i)
                    assert.doesNotMatch(result.receipt, /Continue the original task now/i)
                }
                assert.deepEqual(result.state.compressSummaries[0].messageIds, [
                    "old-user",
                    "old-step",
                    "recent-user",
                    "recent-step",
                ])
                assert.equal(result.state.managementTurns[0]?.completedAt !== undefined, source !== "normal")
            } finally {
                await cleanup(result.sessionId)
            }
        })

        it(`${source} compression preserves the same configured execution tail`, async () => {
            const result = await executePath(source, 1)
            try {
                assert.deepEqual(result.state.compressSummaries[0].messageIds, ["old-user", "old-step", "recent-user"])
                const transformed = structuredClone(result.messages)
                applyCompressTransforms(result.state, logger, transformed)
                assert.equal(transformed.some((message: any) => message.info.id === "recent-step"), true)
                assert.equal(transformed.some((message: any) => message.info.id === "old-step"), false)
            } finally {
                await cleanup(result.sessionId)
            }
        })
    }

    it("keeps existing blocks immutable and appends a new block after the newest one", async () => {
        const sessionId = `existing-block-${Date.now()}-${Math.random()}`
        const callID = "call-existing"
        const messages = [
            textMessage("before", sessionId, "user"),
            textMessage("block-a", sessionId, "assistant"),
            textMessage("block-b", sessionId, "user"),
            textMessage("after-a", sessionId, "assistant"),
            textMessage("after-b", sessionId, "user"),
            textMessage("owner", sessionId, "user"),
            compressCallMessage("compress-message", sessionId, "owner", callID),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        state.compressed.messageIds = new Set(["block-a", "block-b"])
        state.compressSummaries = [
            {
                anchorMessageId: "block-a",
                messageIds: ["block-a", "block-b"],
                summary: "existing summary",
                topic: "Existing",
            },
        ]
        const original = structuredClone(state.compressSummaries[0])
        const tool = createCompressTool({
            client: client(messages), stateManager, logger, config: baseConfig, workingDirectory: "/tmp",
        })

        try {
            await tool.execute(
                { summary: "new summary", topic: "New" },
                toolContext(sessionId, "compress-message", callID),
            )
            assert.deepEqual(state.compressSummaries[0], original)
            assert.deepEqual(state.compressSummaries[1].messageIds, ["after-a", "after-b"])
        } finally {
            await cleanup(sessionId)
        }
    })

    it("ties normal selection to the executing call even when a later user is queued", async () => {
        const sessionId = `queued-user-${Date.now()}-${Math.random()}`
        const callID = "call-queued"
        const messages = [
            textMessage("history", sessionId, "user"),
            textMessage("owner", sessionId, "user"),
            compressCallMessage("compress-message", sessionId, "owner", callID),
            textMessage("queued", sessionId, "user"),
        ]
        const stateManager = new SessionStateManager()
        stateManager.get(sessionId).initialized = true
        const tool = createCompressTool({
            client: client(messages), stateManager, logger, config: baseConfig, workingDirectory: "/tmp",
        })

        try {
            await tool.execute(
                { summary: "history only", topic: "Boundary" },
                toolContext(sessionId, "compress-message", callID),
            )
            assert.deepEqual(stateManager.get(sessionId).compressSummaries[0].messageIds, ["history"])
        } finally {
            await cleanup(sessionId)
        }
    })

    it("fails closed when current-turn ownership is ambiguous", () => {
        const sessionId = "ambiguous"
        const state = new SessionStateManager().get(sessionId)
        const messages = [
            textMessage("owner", sessionId, "user"),
            textMessage("intervening", sessionId, "user"),
            compressCallMessage("compress-message", sessionId, "owner", "call"),
        ]

        assert.throws(
            () => resolveCompressionBoundary(messages, state, "compress-message", "call"),
            /another visible user turn/,
        )
    })

    it("returns a truthful no-op when protected history covers everything", async () => {
        const sessionId = `nothing-eligible-${Date.now()}-${Math.random()}`
        const callID = "call-empty"
        const messages = [
            textMessage("only", sessionId, "user"),
            textMessage("owner", sessionId, "user"),
            compressCallMessage("compress-message", sessionId, "owner", callID),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        let asked = false
        const tool = createCompressTool({
            client: client(messages),
            stateManager,
            logger,
            config: { ...baseConfig, protectedTurns: 3 },
            workingDirectory: "/tmp",
        })

        const receipt = await tool.execute(
            { summary: "unused", topic: "Unused" },
            toolContext(sessionId, "compress-message", callID, async () => { asked = true }),
        )
        assert.match(receipt, /Nothing eligible to compress/)
        assert.equal(asked, false)
        assert.deepEqual(state.compressSummaries, [])
        assert.equal(existsSync(sessionFile(sessionId)), false)
    })

    it("keeps state unchanged when permission is rejected", async () => {
        const sessionId = `permission-failure-${Date.now()}-${Math.random()}`
        const callID = "call-denied"
        const messages = [
            textMessage("history", sessionId, "user"),
            textMessage("owner", sessionId, "user"),
            compressCallMessage("compress-message", sessionId, "owner", callID),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        const tool = createCompressTool({
            client: client(messages), stateManager, logger, config: baseConfig, workingDirectory: "/tmp",
        })

        await assert.rejects(
            tool.execute(
                { summary: "unused", topic: "Unused" },
                toolContext(sessionId, "compress-message", callID, async () => { throw new Error("denied") }),
            ),
            /denied/,
        )
        assert.deepEqual(state.compressSummaries, [])
        assert.equal(state.compressed.messageIds.size, 0)
    })

    it("keeps state unchanged when the transcript fetch fails", async () => {
        const sessionId = "fetch-failure"
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        const tool = createCompressTool({
            client: {
                session: {
                    get: async () => ({ data: {} }),
                    messages: async () => { throw new Error("offline") },
                },
            },
            stateManager,
            logger,
            config: baseConfig,
            workingDirectory: "/tmp",
        })

        await assert.rejects(
            tool.execute(
                { summary: "unused", topic: "Unused" },
                toolContext(sessionId, "compress-message", "call"),
            ),
            /could not fetch session messages: offline/,
        )
        assert.deepEqual(state.compressSummaries, [])
        assert.equal(state.compressed.messageIds.size, 0)
    })

    it("keeps state unchanged when atomic persistence fails", async () => {
        const sessionId = `missing-parent/${Date.now()}`
        const callID = "call-persist-fail"
        const messages = [
            textMessage("history", sessionId, "user"),
            textMessage("owner", sessionId, "user"),
            compressCallMessage("compress-message", sessionId, "owner", callID),
        ]
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        const tool = createCompressTool({
            client: client(messages), stateManager, logger, config: baseConfig, workingDirectory: "/tmp",
        })

        await assert.rejects(
            tool.execute(
                { summary: "unused", topic: "Unused" },
                toolContext(sessionId, "compress-message", callID),
            ),
            /could not persist compression state/,
        )
        assert.deepEqual(state.compressSummaries, [])
        assert.equal(state.compressed.messageIds.size, 0)
    })
})
