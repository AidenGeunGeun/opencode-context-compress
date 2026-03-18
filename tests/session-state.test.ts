import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import {
    SessionStateManager,
    createSessionState,
    ensureSessionInitialized,
} from "../lib/state/state.ts"
import { getLastUserSessionId } from "../lib/hooks.ts"
import { loadSessionState, saveSessionState } from "../lib/state/persistence.ts"

const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as any

const storageDir = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "compress",
)

const getSessionFilePath = (sessionId: string) => join(storageDir, `${sessionId}.json`)

const cleanupSessionFiles = async (sessionId: string) => {
    const filePath = getSessionFilePath(sessionId)
    await rm(filePath, { force: true }).catch(() => undefined)

    if (!existsSync(storageDir)) {
        return
    }

    const entries = await readdir(storageDir)
    await Promise.all(
        entries
            .filter((entry) => entry.startsWith(`${sessionId}.json.tmp-`))
            .map((entry) => rm(join(storageDir, entry), { force: true })),
    )
}

const createMessage = (id: string, sessionID: string, role: "user" | "assistant") => ({
    info: {
        id,
        role,
        sessionID,
        agent: "agent-test",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        time: { created: Date.now() },
    },
    parts: role === "user" ? [{ type: "text", text: `message-${id}` }] : [],
})

describe("SessionStateManager", () => {
    it("returns isolated state objects per session", () => {
        const manager = new SessionStateManager()
        const mainState = manager.get("main-session")
        const subagentState = manager.get("subagent-session")

        mainState.compressed.messageIds.add("m1")
        mainState.compressSummaries.push({
            anchorMessageId: "m1",
            messageIds: ["m1"],
            summary: "main summary",
        })
        mainState.variant = "high"

        assert.notStrictEqual(mainState, subagentState)
        assert.equal(mainState.sessionId, "main-session")
        assert.equal(subagentState.sessionId, "subagent-session")
        assert.equal(subagentState.compressed.messageIds.size, 0)
        assert.equal(subagentState.compressSummaries.length, 0)
        assert.equal(subagentState.variant, undefined)
    })

    it("returns the same object when the same session is requested again", () => {
        const manager = new SessionStateManager()
        const state = manager.get("main-session")

        state.currentTurn = 7

        assert.strictEqual(manager.get("main-session"), state)
        assert.equal(manager.get("main-session").currentTurn, 7)
    })
})

describe("getLastUserSessionId", () => {
    it("uses the last user message session id", () => {
        const messages = [
            createMessage("m1", "main-session", "user"),
            createMessage("m2", "main-session", "assistant"),
            createMessage("m3", "subagent-session", "user"),
            createMessage("m4", "subagent-session", "assistant"),
        ]

        assert.equal(getLastUserSessionId(messages as any), "subagent-session")
    })
})

describe("ensureSessionInitialized", () => {
    it("marks state initialized without clearing cached variant", async () => {
        const sessionId = `session-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const state = createSessionState()
        state.sessionId = sessionId
        state.variant = "cached-variant"

        const client = {
            session: {
                get: async () => ({ data: {} }),
            },
        }
        const messages = [
            createMessage("m1", sessionId, "user"),
            {
                ...createMessage("m2", sessionId, "assistant"),
                parts: [{ type: "step-start" }],
            },
        ]

        await ensureSessionInitialized(client, state, sessionId, logger, messages as any)

        assert.equal(state.initialized, true)
        assert.equal(state.sessionId, sessionId)
        assert.equal(state.variant, "cached-variant")
        assert.equal(state.currentTurn, 1)
    })

    it("clears persisted compression only when the session file is definitively absent", async () => {
        const sessionId = `session-state-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFiles(sessionId)

        try {
            const state = createSessionState()
            state.sessionId = sessionId
            state.hasPersistedState = true
            state.persistedLastUpdated = "existing-timestamp"
            state.compressed.messageIds = new Set(["m2"])
            state.compressSummaries = [
                {
                    anchorMessageId: "m2",
                    messageIds: ["m2"],
                    summary: "kept until file is truly absent",
                },
            ]
            state.stats = {
                compressTokenCounter: 5,
                totalCompressTokens: 9,
            }

            const client = {
                session: {
                    get: async () => ({ data: {} }),
                },
            }
            const messages = [createMessage("m1", sessionId, "user")]

            const syncResult = await ensureSessionInitialized(client, state, sessionId, logger, messages as any)

            assert.equal(syncResult.source, "disk-cleared")
            assert.equal(state.hasPersistedState, false)
            assert.equal(state.persistedLastUpdated, null)
            assert.equal(state.compressed.messageIds.size, 0)
            assert.deepEqual(state.compressSummaries, [])
            assert.deepEqual(state.stats, {
                compressTokenCounter: 0,
                totalCompressTokens: 0,
            })
        } finally {
            await cleanupSessionFiles(sessionId)
        }
    })

    it("keeps in-memory compression when the persisted file is malformed", async () => {
        const sessionId = `session-state-malformed-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFiles(sessionId)

        try {
            const state = createSessionState()
            state.sessionId = sessionId
            state.hasPersistedState = true
            state.persistedLastUpdated = "existing-timestamp"
            state.compressed.messageIds = new Set(["m2", "m3"])
            state.compressSummaries = [
                {
                    anchorMessageId: "m2",
                    messageIds: ["m2", "m3"],
                    summary: "existing overlay summary",
                },
            ]
            state.stats = {
                compressTokenCounter: 13,
                totalCompressTokens: 21,
            }

            await mkdir(storageDir, { recursive: true })
            await writeFile(getSessionFilePath(sessionId), "{ not-valid-json", "utf-8")

            const loadResult = await loadSessionState(sessionId, logger)
            assert.equal(loadResult.status, "error")

            const client = {
                session: {
                    get: async () => ({ data: {} }),
                },
            }
            const messages = [
                createMessage("m1", sessionId, "user"),
                createMessage("m2", sessionId, "assistant"),
                createMessage("m3", sessionId, "assistant"),
            ]

            const syncResult = await ensureSessionInitialized(client, state, sessionId, logger, messages as any)

            assert.equal(syncResult.source, "memory")
            assert.equal(state.hasPersistedState, true)
            assert.equal(state.persistedLastUpdated, "existing-timestamp")
            assert.deepEqual([...state.compressed.messageIds], ["m2", "m3"])
            assert.deepEqual(state.compressSummaries, [
                {
                    anchorMessageId: "m2",
                    messageIds: ["m2", "m3"],
                    summary: "existing overlay summary",
                },
            ])
            assert.deepEqual(state.stats, {
                compressTokenCounter: 13,
                totalCompressTokens: 21,
            })
        } finally {
            await cleanupSessionFiles(sessionId)
        }
    })
})

describe("saveSessionState", () => {
    it("writes via a temp file and leaves only the final session json", async () => {
        const sessionId = `session-state-save-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFiles(sessionId)

        try {
            const state = createSessionState()
            state.sessionId = sessionId
            state.compressed.toolIds = new Set(["tool-1"])
            state.compressed.messageIds = new Set(["m2", "m3"])
            state.compressSummaries = [
                {
                    anchorMessageId: "m2",
                    messageIds: ["m2", "m3"],
                    summary: "persisted summary",
                },
            ]
            state.stats = {
                compressTokenCounter: 8,
                totalCompressTokens: 34,
            }

            await saveSessionState(state, logger, "session-name")

            assert.equal(existsSync(getSessionFilePath(sessionId)), true)

            const entries = await readdir(storageDir)
            assert.equal(entries.some((entry) => entry.startsWith(`${sessionId}.json.tmp-`)), false)

            const loadResult = await loadSessionState(sessionId, logger)
            assert.equal(loadResult.status, "loaded")
            if (loadResult.status !== "loaded") {
                throw new Error(`Expected loaded state, got ${loadResult.status}`)
            }

            assert.deepEqual(loadResult.state.compressed.toolIds, ["tool-1"])
            assert.deepEqual(loadResult.state.compressed.messageIds, ["m2", "m3"])
            assert.deepEqual(loadResult.state.compressSummaries, [
                {
                    anchorMessageId: "m2",
                    messageIds: ["m2", "m3"],
                    summary: "persisted summary",
                },
            ])
            assert.deepEqual(loadResult.state.stats, {
                compressTokenCounter: 8,
                totalCompressTokens: 34,
            })
            assert.equal(state.hasPersistedState, true)
            assert.equal(typeof state.persistedLastUpdated, "string")
        } finally {
            await cleanupSessionFiles(sessionId)
        }
    })
})
