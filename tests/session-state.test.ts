import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    SessionStateManager,
    createSessionState,
    ensureSessionInitialized,
} from "../lib/state/state.ts"
import { getLastUserSessionId } from "../lib/hooks.ts"

const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as any

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
})
