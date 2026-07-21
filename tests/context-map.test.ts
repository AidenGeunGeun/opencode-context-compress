import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { selectDeterministicCompressionSpan } from "../lib/messages/context-map.ts"
import { createSessionState } from "../lib/state/state.ts"

const logger = { info: () => {}, warn: () => {} } as any

function message(id: string, role: "user" | "assistant", stepStart = false) {
    return {
        info: {
            id,
            role,
            sessionID: "selection-session",
            time: { created: Date.now() },
        },
        parts: [
            ...(stepStart ? [{ type: "step-start" }] : []),
            { type: "text", text: id },
        ],
    } as any
}

describe("deterministic compression selection", () => {
    it("preserves the newest configured execution steps", () => {
        const state = createSessionState()
        const messages = [
            message("u1", "user"),
            message("a1", "assistant", true),
            message("u2", "user"),
            message("a2", "assistant", true),
            message("u3", "user"),
            message("a3", "assistant", true),
        ]

        const span = selectDeterministicCompressionSpan(messages, state, logger, 2)

        assert.deepEqual(span.messageIds, ["u1", "a1", "u2"])
        assert.deepEqual(span.protectedMessageIds, ["a2", "u3", "a3"])
    })

    it("uses the recent-message fallback when imported history has no step-start parts", () => {
        const state = createSessionState()
        const messages = [
            message("m1", "user"),
            message("m2", "assistant"),
            message("m3", "user"),
            message("m4", "assistant"),
        ]

        const span = selectDeterministicCompressionSpan(messages, state, logger, 3)

        assert.deepEqual(span.messageIds, ["m1"])
        assert.deepEqual(span.protectedMessageIds, ["m2", "m3", "m4"])
    })

    it("protects nothing when protectedTurns is zero", () => {
        const state = createSessionState()
        const messages = [message("m1", "user"), message("m2", "assistant", true)]

        const span = selectDeterministicCompressionSpan(messages, state, logger, 0)

        assert.deepEqual(span.messageIds, ["m1", "m2"])
        assert.deepEqual(span.protectedMessageIds, [])
    })

    it("fails closed when a durable block cannot be reconciled with the transcript", () => {
        const state = createSessionState()
        state.compressed.messageIds = new Set(["missing-anchor"])
        state.compressSummaries = [
            {
                anchorMessageId: "missing-anchor",
                messageIds: ["missing-anchor"],
                summary: "durable block",
            },
        ]

        assert.throws(
            () =>
                selectDeterministicCompressionSpan(
                    [message("visible", "user")],
                    state,
                    logger,
                    0,
                ),
            /could not reconcile an existing compressed block/,
        )
    })
})
