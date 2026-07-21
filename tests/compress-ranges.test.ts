import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { selectDeterministicCompressionSpan } from "../lib/messages/context-map.ts"
import { createSessionState } from "../lib/state/state.ts"

const logger = { info: () => {}, warn: () => {} } as any
const message = (id: string, role: "user" | "assistant" = "user") => ({
    info: { id, role, sessionID: "block-session", time: { created: Date.now() } },
    parts: [{ type: "text", text: id }],
}) as any

describe("existing block exclusion", () => {
    it("selects only canonical uncompressed messages after the newest existing block", () => {
        const state = createSessionState()
        state.compressed.messageIds = new Set(["m2", "m3", "m5", "m6"])
        state.compressSummaries = [
            {
                anchorMessageId: "m5",
                messageIds: ["m5", "m6"],
                summary: "newest block",
                topic: "Newest",
            },
            {
                anchorMessageId: "m2",
                messageIds: ["m2", "m3"],
                summary: "older block",
                topic: "Older",
            },
        ]
        const messages = [
            message("m1"),
            message("m2", "assistant"),
            message("m3"),
            message("m4", "assistant"),
            message("m5"),
            message("m6", "assistant"),
            message("m7"),
            message("m8", "assistant"),
        ]

        const span = selectDeterministicCompressionSpan(messages, state, logger, 0)

        assert.deepEqual(span.messageIds, ["m7", "m8"])
        assert.deepEqual(state.compressSummaries.map((summary) => summary.anchorMessageId), ["m5", "m2"])
        assert.deepEqual([...state.compressed.messageIds], ["m2", "m3", "m5", "m6"])
    })
})
