import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { isIgnoredUserMessage } from "../lib/messages/utils.ts"
import { getCompletedToolOutputText } from "../lib/tools/utils.ts"

describe("isIgnoredUserMessage", () => {
    it("returns true for empty parts", () => {
        const msg = { info: { id: "test-1" }, parts: [] } as any
        assert.equal(isIgnoredUserMessage(msg), true)
    })

    it("returns true when all parts are ignored", () => {
        const msg = {
            info: { id: "test-2" },
            parts: [{ type: "text", text: "hello", ignored: true }],
        } as any

        assert.equal(isIgnoredUserMessage(msg), true)
    })

    it("returns false for a normal text part", () => {
        const msg = { info: { id: "test-3" }, parts: [{ type: "text", text: "hello" }] } as any

        assert.equal(isIgnoredUserMessage(msg), false)
    })

    it("returns false for mixed ignored and non-ignored parts", () => {
        const msg = {
            info: { id: "test-4" },
            parts: [
                { type: "text", text: "hidden", ignored: true },
                { type: "text", text: "visible" },
            ],
        } as any

        assert.equal(isIgnoredUserMessage(msg), false)
    })
})

describe("getCompletedToolOutputText", () => {
    it("returns a completed string output unchanged", () => {
        const part = { tool: "read" }

        assert.equal(getCompletedToolOutputText(part, "file contents"), "file contents")
    })

    it("drops falsy non-image output when requireTruthy is set", () => {
        const part = { tool: "read" }

        assert.equal(getCompletedToolOutputText(part, 0, { requireTruthy: true }), undefined)
    })

    it("serializes non-string output only when stringifyNonString is set", () => {
        const part = { tool: "read" }

        assert.equal(getCompletedToolOutputText(part, { a: 1 }), undefined)
        assert.equal(
            getCompletedToolOutputText(part, { a: 1 }, { stringifyNonString: true }),
            JSON.stringify({ a: 1 }),
        )
    })

    it("replaces generated-image output with a placeholder that includes the callID", () => {
        const part = { tool: "image_generation", callID: "call-image" }

        assert.equal(
            getCompletedToolOutputText(part, JSON.stringify({ result: "A".repeat(4096) })),
            "[generated image: call-image]",
        )
    })

    it("still emits a generated-image placeholder when the completed output is falsy", () => {
        const part = { tool: "image_generation", callID: "call-image" }

        assert.equal(
            getCompletedToolOutputText(part, "", { requireTruthy: true }),
            "[generated image: call-image]",
        )
    })

    it("keeps generated-image placeholders short when callIDs are very long", () => {
        const part = { tool: "image_generation", callID: "call-" + "x".repeat(200) }

        const placeholder = getCompletedToolOutputText(part, "")!
        assert.ok(placeholder.startsWith("[generated image: call-"))
        assert.ok(placeholder.endsWith("...]"))
        assert.ok(placeholder.length <= 80)
    })

    it("falls back to a generic generated-image placeholder without a callID", () => {
        const part = { tool: "image_generation" }

        assert.equal(getCompletedToolOutputText(part, "payload"), "[generated image]")
    })
})
