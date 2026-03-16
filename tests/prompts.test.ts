import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { loadPrompt, renderSystemPrompt } from "../lib/prompts/index.ts"

const COMPRESS_GUIDANCE = "YOUR ONE JOB: COMPRESS"
const INDEX_GUIDANCE = "Select ranges by index number"

describe("renderSystemPrompt", () => {
    it("includes compress section when flag is true", () => {
        const output = renderSystemPrompt({ compress: true })

        assert.match(output, /system-reminder/)
        assert.equal(output.includes(COMPRESS_GUIDANCE), true)
        assert.equal(output.includes(INDEX_GUIDANCE), true)
        assert.match(output, /\/compress manage/)
        assert.match(output, /<compress-context-map>/)
    })

    it("still renders system prompt when compress flag is false", () => {
        const output = renderSystemPrompt({ compress: false })

        assert.match(output, /<system-reminder>/)
        // Compress-conditional content should be stripped, but top-level guidance may remain
        assert.doesNotMatch(output, /<compress>/)
    })

    it("strips raw conditional wrapper tags", () => {
        const output = renderSystemPrompt({ compress: true })

        assert.doesNotMatch(output, /<compress>/)
        assert.doesNotMatch(output, /<\/compress>/)
    })

    it("omits removed legacy tool guidance", () => {
        const output = renderSystemPrompt({ compress: true })

        assert.doesNotMatch(output, /sweep/i)
        assert.doesNotMatch(output, /startString/)
        assert.doesNotMatch(output, /endString/)
    })

    it("does not mention string boundary matching fields", () => {
        const output = renderSystemPrompt({ compress: true })

        assert.doesNotMatch(output, /startString/)
        assert.doesNotMatch(output, /endString/)
        assert.doesNotMatch(output, /BOUNDARY MATCHING/)
    })
})

describe("loadPrompt", () => {
    it("returns non-empty content for compress-tool-spec", () => {
        const output = loadPrompt("compress-tool-spec")

        assert.equal(typeof output, "string")
        assert.ok(output.length > 0)
    })

    it("throws when prompt key does not exist", () => {
        assert.throws(
            () => loadPrompt("nonexistent"),
            (error: unknown) => error instanceof Error && error.message.includes("Prompt not found"),
        )
    })

    it("ignores vars that do not match placeholders", () => {
        const output = loadPrompt("compress-tool-spec", { someVar: "value" })

        assert.equal(typeof output, "string")
        assert.ok(output.length > 0)
    })
})
