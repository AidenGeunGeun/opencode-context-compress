import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadPrompt, renderSystemPrompt } from "../lib/prompts/index.ts"
import { SYSTEM } from "../lib/prompts/_codegen/system.generated.ts"
import { COMPRESS } from "../lib/prompts/_codegen/compress.generated.ts"
import { COMPRESS_MAP } from "../lib/prompts/_codegen/compress-map.generated.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

const COMPRESS_GUIDANCE = "CONTEXT MANAGEMENT REQUESTED"
const DENSITY_GUIDANCE = "Older or less-relevant completed work should be terse."
const COMPRESS_MAP_GUIDANCE = "Use `compress_map` to read the current context map."

describe("renderSystemPrompt", () => {
    it("includes compress section when flag is true", () => {
        const output = renderSystemPrompt({ compress: true, compress_map: true })

        assert.match(output, /system-reminder/)
        assert.equal(output.includes(COMPRESS_GUIDANCE), true)
        assert.equal(output.includes(DENSITY_GUIDANCE), true)
        assert.equal(output.includes(COMPRESS_MAP_GUIDANCE), true)
        assert.match(output, /\/compress manage/)
        assert.doesNotMatch(output, /<compress-context-map>/)
        assert.doesNotMatch(output, /EXHAUSTIVE/)
    })

    it("still renders system prompt when tool flags are false", () => {
        const output = renderSystemPrompt({ compress: false, compress_map: false })

        assert.match(output, /<system-reminder>/)
        assert.doesNotMatch(output, /<compress>/)
        assert.doesNotMatch(output, /<compress_map>/)
    })

    it("strips raw conditional wrapper tags", () => {
        const output = renderSystemPrompt({ compress: true, compress_map: true })

        assert.doesNotMatch(output, /<compress>/)
        assert.doesNotMatch(output, /<\/compress>/)
        assert.doesNotMatch(output, /<compress_map>/)
        assert.doesNotMatch(output, /<\/compress_map>/)
    })

    it("omits removed legacy tool guidance", () => {
        const output = renderSystemPrompt({ compress: true, compress_map: true })

        assert.doesNotMatch(output, /sweep/i)
        assert.doesNotMatch(output, /startString/)
        assert.doesNotMatch(output, /endString/)
    })

    it("does not mention string boundary matching fields", () => {
        const output = renderSystemPrompt({ compress: true, compress_map: true })

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

    it("returns non-empty content for compress-map-tool-spec", () => {
        const output = loadPrompt("compress-map-tool-spec")

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

    it("generated prompt code matches the markdown sources", () => {
        const systemSource = readFileSync(join(__dirname, "../lib/prompts/system.md"), "utf-8")
        const compressSource = readFileSync(join(__dirname, "../lib/prompts/compress.md"), "utf-8")
        const compressMapSource = readFileSync(join(__dirname, "../lib/prompts/compress-map.md"), "utf-8")

        assert.equal(SYSTEM, systemSource)
        assert.equal(COMPRESS, compressSource)
        assert.equal(COMPRESS_MAP, compressMapSource)
    })
})
