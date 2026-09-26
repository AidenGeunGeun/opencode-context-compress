import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
    loadPrompt,
    renderAutomaticSystemPrompt,
    renderPostCompressionNotice,
    renderSquashSystemPrompt,
    renderSystemPrompt,
} from "../lib/prompts/index.ts"
import { SYSTEM } from "../lib/prompts/_codegen/system.generated.ts"
import { AUTOMATIC_SYSTEM } from "../lib/prompts/_codegen/automatic-system.generated.ts"
import { COMPRESS } from "../lib/prompts/_codegen/compress.generated.ts"
import { SQUASH_SYSTEM } from "../lib/prompts/_codegen/squash-system.generated.ts"
import { SQUASH } from "../lib/prompts/_codegen/squash.generated.ts"
import { POST_COMPRESSION_NOTICE } from "../lib/prompts/_codegen/post-compression-notice.generated.ts"

const RETIRED = /compress_map|compress-context-map|pinned snapshot|handoff report|session notes|continuity file|goal reference/i

describe("compression prompts", () => {
    it("renders deterministic manual and automatic one-call workflows", () => {
        const manual = renderSystemPrompt()
        const automatic = renderAutomaticSystemPrompt({
            context_tokens: "355,000",
            threshold_tokens: "350,000",
            threshold_reason: "the absolute token threshold",
        })

        assert.match(manual, /call `compress` once, before this turn ends, with `summary` and `topic`/)
        assert.match(manual, /clean stopping point/)
        assert.match(automatic, /clean stopping point/)
        assert.match(automatic, /before this turn ends/)
        assert.match(manual, /newest configured execution steps verbatim/)
        assert.match(automatic, /355,000/)
        assert.match(automatic, /350,000/)
        assert.match(automatic, /call `compress` once/i)
        assert.match(automatic, /continue immediately only when work was genuinely active/i)
        assert.doesNotMatch(manual, RETIRED)
        assert.doesNotMatch(automatic, RETIRED)
    })

    it("keeps range selection isolated to squash", () => {
        const system = renderSquashSystemPrompt()
        const tool = loadPrompt("squash-tool-spec")
        assert.match(system, /contiguous inclusive range/i)
        assert.match(system, /Call `squash` once with `from`, `to`, `summary`, and `topic`/)
        assert.match(tool, /USER EXPLICITLY REQUESTED BLOCK SQUASHING/i)
        assert.doesNotMatch(system, RETIRED)
    })

    it("keeps generated sources synchronized", () => {
        const root = process.cwd()
        assert.equal(SYSTEM, readFileSync(join(root, "lib/prompts/system.md"), "utf8"))
        assert.equal(AUTOMATIC_SYSTEM, readFileSync(join(root, "lib/prompts/automatic-system.md"), "utf8"))
        assert.equal(COMPRESS, readFileSync(join(root, "lib/prompts/compress.md"), "utf8"))
        assert.equal(SQUASH_SYSTEM, readFileSync(join(root, "lib/prompts/squash-system.md"), "utf8"))
        assert.equal(SQUASH, readFileSync(join(root, "lib/prompts/squash.md"), "utf8"))
        assert.equal(POST_COMPRESSION_NOTICE, readFileSync(join(root, "lib/prompts/post-compression-notice.md"), "utf8"))
        assert.equal(SYSTEM.trim(), renderSystemPrompt())
        assert.equal(SQUASH_SYSTEM.trim(), renderSquashSystemPrompt())
        assert.equal(COMPRESS.trim(), loadPrompt("compress-tool-spec").trim())
        assert.equal(SQUASH.trim(), loadPrompt("squash-tool-spec").trim())
    })

    it("delivers a transient post-compression reread notice", () => {
        const output = renderPostCompressionNotice()
        assert.match(output, /context was compressed/i)
        assert.match(output, /reload the skills and project instructions required by the active task/i)
        assert.match(output, /continue the original task/i)
        assert.doesNotMatch(output, RETIRED)
    })
})
