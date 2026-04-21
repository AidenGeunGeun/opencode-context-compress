import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { extractParameterKey, isIgnoredUserMessage } from "../lib/messages/utils.ts"
import { extractToolContent } from "../lib/token-utils.ts"

describe("extractParameterKey", () => {
    it("returns read file path", () => {
        assert.equal(extractParameterKey("read", { filePath: "/foo/bar.ts" }), "/foo/bar.ts")
    })

    it("returns read path with line range when offset and limit are provided", () => {
        assert.equal(
            extractParameterKey("read", { filePath: "/foo.ts", offset: 10, limit: 20 }),
            "/foo.ts (lines 10-30)",
        )
    })

    it("prefers bash description over command", () => {
        assert.equal(
            extractParameterKey("bash", { command: "npm test", description: "Run tests" }),
            "Run tests",
        )
    })

    it("formats glob pattern and path", () => {
        assert.equal(extractParameterKey("glob", { pattern: "**/*.ts", path: "/src" }), '"**/*.ts" in /src')
    })

    it("returns empty string for unknown tool with null params", () => {
        assert.equal(extractParameterKey("unknown_tool", null), "")
    })

    it("returns empty string for unknown tool with empty params", () => {
        assert.equal(extractParameterKey("unknown_tool", {}), "")
    })
})

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

describe("extractToolContent", () => {
    it("extracts serialized question input", () => {
        const part = {
            tool: "question",
            state: { input: { questions: [{ header: "test" }] } },
        }

        assert.deepEqual(extractToolContent(part), [JSON.stringify([{ header: "test" }])])
    })

    it("extracts completed output", () => {
        const part = {
            tool: "read",
            state: { status: "completed", output: "file contents" },
        }

        assert.deepEqual(extractToolContent(part), ["file contents"])
    })

    it("preserves falsy completed outputs for non-image tools as non-content", () => {
        const part = {
            tool: "read",
            state: { status: "completed", output: 0 },
        }

        assert.deepEqual(extractToolContent(part), [])
    })

    it("replaces generated-image output with a placeholder that includes the callID", () => {
        const part = {
            tool: "image_generation",
            callID: "call-image",
            state: {
                status: "completed",
                output: JSON.stringify({ result: "A".repeat(4096) }),
            },
        }

        assert.deepEqual(extractToolContent(part), ["[generated image: call-image]"])
    })

    it("still emits a generated-image placeholder when the completed output is falsy", () => {
        const part = {
            tool: "image_generation",
            callID: "call-image",
            state: {
                status: "completed",
                output: "",
            },
        }

        assert.deepEqual(extractToolContent(part), ["[generated image: call-image]"])
    })

    it("keeps generated-image placeholders short when callIDs are very long", () => {
        const part = {
            tool: "image_generation",
            callID: "call-" + "x".repeat(200),
            state: {
                status: "completed",
                output: JSON.stringify({ result: "A".repeat(4096) }),
            },
        }

        const [placeholder] = extractToolContent(part)
        assert.ok(placeholder.startsWith("[generated image: call-"))
        assert.ok(placeholder.endsWith("...]"))
        assert.ok(placeholder.length <= 80)
    })

    it("falls back to a generic generated-image placeholder without a callID", () => {
        const part = {
            tool: "image_generation",
            state: {
                status: "completed",
                output: JSON.stringify({ result: "A".repeat(4096) }),
            },
        }

        assert.deepEqual(extractToolContent(part), ["[generated image]"])
    })

    it("extracts error output when tool failed", () => {
        const part = {
            tool: "read",
            state: { status: "error", error: "not found" },
        }

        assert.deepEqual(extractToolContent(part), ["not found"])
    })

    it("keeps image-generation errors on the error branch", () => {
        const part = {
            tool: "image_generation",
            callID: "call-image",
            state: { status: "error", error: "generation failed" },
        }

        assert.deepEqual(extractToolContent(part), ["generation failed"])
    })

    it("includes write input and output", () => {
        const part = {
            tool: "write",
            state: {
                input: { filePath: "/f", content: "x" },
                status: "completed",
                output: "ok",
            },
        }

        assert.deepEqual(extractToolContent(part), [JSON.stringify({ filePath: "/f", content: "x" }), "ok"])
    })
})
