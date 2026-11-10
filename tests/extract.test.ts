import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { isIgnoredUserMessage } from "../lib/messages/utils.ts"
import type { Part, WithParts } from "../lib/state/types.ts"

const userMessage = (id: string, parts: Part[]): WithParts => ({
    info: { id, sessionID: "session", role: "user", time: { created: 0 } },
    parts,
})

describe("isIgnoredUserMessage", () => {
    it("returns true for empty parts", () => {
        const msg = userMessage("test-1", [])
        assert.equal(isIgnoredUserMessage(msg), true)
    })

    it("returns true when all parts are ignored", () => {
        const msg = userMessage("test-2", [{ type: "text", text: "hello", ignored: true }])

        assert.equal(isIgnoredUserMessage(msg), true)
    })

    it("returns false for a normal text part", () => {
        const msg = userMessage("test-3", [{ type: "text", text: "hello" }])

        assert.equal(isIgnoredUserMessage(msg), false)
    })

    it("returns false for mixed ignored and non-ignored parts", () => {
        const msg = userMessage("test-4", [
            { type: "text", text: "hidden", ignored: true },
            { type: "text", text: "visible" },
        ])

        assert.equal(isIgnoredUserMessage(msg), false)
    })
})
