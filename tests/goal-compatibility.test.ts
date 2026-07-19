import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    isContextOverflowError,
    isGoalContinuationMessage,
    recoverGoalAfterCompression,
    type GoalOverflowRecovery,
} from "../lib/goal.ts"
import { createChatMessageHandler } from "../lib/hooks.ts"
import { findActiveManagementTurn } from "../lib/messages/compress-transform.ts"
import { createCompressionMapSnapshot, buildContextMap } from "../lib/messages/context-map.ts"
import { SessionStateManager } from "../lib/state/state.ts"

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
} as any

function message(id: string, role: "user" | "assistant", text: string, synthetic = false) {
    return {
        info: {
            id,
            sessionID: "ses_goal_compat",
            role,
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            time: { created: Date.now() },
        },
        parts: [{ type: "text", text, ...(synthetic ? { synthetic: true } : {}) }],
    } as any
}

const continuation = message(
    "goal-continuation",
    "user",
    [
        "Continue pursuing the active session goal.",
        "Goal reference: goa_compat 1700000000000",
        'Objective (untrusted user data): "Finish compatibility"',
    ].join("\n"),
    true,
)

describe("Goal continuation compatibility", () => {
    it("recognizes only the synthetic stable marker combination", () => {
        assert.equal(isGoalContinuationMessage(continuation), true)
        assert.equal(
            isGoalContinuationMessage(message("plain", "user", "Continue pursuing the active session goal.")),
            false,
        )
        assert.equal(isGoalContinuationMessage(message("other", "user", "Synthetic maintenance", true)), false)
    })

    it("does not bound an open management turn or invalidate its pinned map", async () => {
        const sessionId = `ses_goal_boundary_${Date.now()}`
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        const history = [message("old-user", "user", "Original request"), message("old-assistant", "assistant", "Work")]
        const trigger = message("manage-trigger", "user", "Automatic compression")
        const messages = [...history, trigger, { ...continuation, info: { ...continuation.info, sessionID: sessionId } }]
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true
        state.managementTurns = [{ triggerMessageId: trigger.info.id, source: "automatic" }]
        state.compressionMapSnapshot = createCompressionMapSnapshot(
            trigger.info.id,
            buildContextMap(history as any, state, logger),
            { source: "management" },
        )

        assert.equal(findActiveManagementTurn(state, messages as any)?.turn.triggerMessageId, trigger.info.id)
        const snapshot = state.compressionMapSnapshot
        await createChatMessageHandler(stateManager, logger)(
            { sessionID: sessionId, messageID: continuation.info.id },
            { message: continuation.info, parts: continuation.parts },
        )
        assert.equal(state.compressionMapSnapshot, snapshot)

        messages.push(message("real-user", "user", "A real user boundary"))
        assert.equal(findActiveManagementTurn(state, messages as any), undefined)
    })
})

describe("Goal overflow recovery ownership", () => {
    const recovery: GoalOverflowRecovery = {
        overflowMessageId: "msg_overflow",
        goalID: "goa_same",
        timeUpdated: 1700000000000,
    }
    const blocked = {
        id: recovery.goalID,
        sessionID: "ses_goal",
        objective: "Recover",
        status: "blocked" as const,
        time: { created: 1, updated: recovery.timeUpdated },
    }

    it("resumes the exact blocked Goal with its owner token", async () => {
        const updates: unknown[] = []
        const client = {
            _client: {},
            session: {
                goal: async () => ({ data: blocked }),
                goalUpdate: async (input: unknown) => {
                    updates.push(input)
                    return { data: { ...blocked, status: "active" } }
                },
            },
        }

        assert.equal(await recoverGoalAfterCompression(client, blocked.sessionID, recovery), "resumed")
        assert.deepEqual(updates, [
            {
                path: { id: blocked.sessionID },
                body: { action: "resume", owner: recovery },
            },
        ])
    })

    it("never resumes a stale, replaced, or manually paused Goal", async () => {
        for (const goal of [
            { ...blocked, id: "goa_replacement" },
            { ...blocked, time: { ...blocked.time, updated: blocked.time.updated + 1 } },
            { ...blocked, status: "paused" as const },
        ]) {
            let updates = 0
            const client = {
                _client: {},
                session: {
                    goal: async () => ({ data: goal }),
                    goalUpdate: async () => {
                        updates++
                        return { data: goal }
                    },
                },
            }
            assert.equal(await recoverGoalAfterCompression(client, blocked.sessionID, recovery), "changed")
            assert.equal(updates, 0)
        }
    })

    it("fails open when the host has no Goal API", async () => {
        assert.equal(await recoverGoalAfterCompression({ session: {} }, blocked.sessionID, recovery), "unavailable")
    })

    it("surfaces a real resume failure while the same Goal remains blocked", async () => {
        const client = {
            _client: {},
            session: {
                goal: async () => ({ data: blocked }),
                goalUpdate: async () => ({ error: { message: "resume failed" } }),
            },
        }
        await assert.rejects(() => recoverGoalAfterCompression(client, blocked.sessionID, recovery), /resume failed/)
    })

    it("recognizes only the host context-overflow error", () => {
        assert.equal(isContextOverflowError({ name: "ContextOverflowError" }), true)
        assert.equal(isContextOverflowError({ name: "ProviderAuthError" }), false)
    })
})
