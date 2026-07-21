import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
    loadPrompt,
    renderAutomaticSystemPrompt,
    renderSystemPrompt,
} from "../lib/prompts/index.ts"
import { SYSTEM } from "../lib/prompts/_codegen/system.generated.ts"
import { AUTOMATIC_SYSTEM } from "../lib/prompts/_codegen/automatic-system.generated.ts"
import { COMPRESS } from "../lib/prompts/_codegen/compress.generated.ts"
import { renderGoalOverflowRecoveryPrompt } from "../lib/goal.ts"

const RETIRED_WORKFLOW = /compress_map|compress-context-map|pinned snapshot|numeric (?:entry|label)|from\/to|narrower range|consolidat(?:e|ion)/i

describe("single-tool agent prompts", () => {
    it("renders manual management as one compress call", () => {
        const output = renderSystemPrompt()
        assert.match(output, /Call `compress` once with `summary` and `topic`/)
        assert.match(output, /newest configured execution steps verbatim/)
        assert.match(output, /Existing compressed blocks are excluded automatically/)
        assert.match(output, /Later evidence supersedes stale plans/i)
        assert.match(output, /Do not invent one for completed work/i)
        assert.doesNotMatch(output, RETIRED_WORKFLOW)
    })

    it("renders automatic management with current variables and continuation rules", () => {
        const output = renderAutomaticSystemPrompt({
            context_tokens: "355,000",
            threshold_tokens: "350,000",
            threshold_reason: "the system-wide absolute token limit",
        })
        assert.match(output, /355,000/)
        assert.match(output, /350,000/)
        assert.match(output, /call `compress` once/i)
        assert.match(output, /continue immediately only when work was genuinely active/i)
        assert.match(output, /do not reopen completed work/i)
        assert.doesNotMatch(output, RETIRED_WORKFLOW)
    })

    it("exposes only summary and topic concepts in the tool description", () => {
        const output = loadPrompt("compress-tool-spec")
        assert.match(output, /Tool availability alone is not authorization/)
        assert.match(output, /`summary`/)
        assert.match(output, /`topic`/)
        assert.match(output, /all eligible uncompressed history after the newest existing block/i)
        assert.doesNotMatch(output, RETIRED_WORKFLOW)
    })

    it("keeps generated prompt sources synchronized and free of retired workflow text", () => {
        const root = process.cwd()
        const systemSource = readFileSync(join(root, "lib/prompts/system.md"), "utf8")
        const automaticSource = readFileSync(
            join(root, "lib/prompts/automatic-system.md"),
            "utf8",
        )
        const compressSource = readFileSync(join(root, "lib/prompts/compress.md"), "utf8")
        assert.equal(SYSTEM, systemSource)
        assert.equal(AUTOMATIC_SYSTEM, automaticSource)
        assert.equal(COMPRESS, compressSource)
        assert.equal(SYSTEM.trim(), renderSystemPrompt())
        assert.equal(COMPRESS.trim(), loadPrompt("compress-tool-spec").trim())
        for (const generated of [SYSTEM, AUTOMATIC_SYSTEM, COMPRESS]) {
            assert.doesNotMatch(generated, RETIRED_WORKFLOW)
        }
        assert.throws(() => loadPrompt("compress-map-tool-spec"), /Prompt not found/)
    })

    it("uses the same one-call workflow for Goal overflow recovery", () => {
        const output = renderGoalOverflowRecoveryPrompt()
        assert.match(output, /call compress once/i)
        assert.match(output, /newest configured execution steps/)
        assert.doesNotMatch(output, RETIRED_WORKFLOW)
    })

    it("has no removed prompt source or generated module", () => {
        const root = process.cwd()
        assert.throws(() => readFileSync(join(root, "lib/prompts/compress-map.md"), "utf8"))
        assert.throws(() =>
            readFileSync(join(root, "lib/prompts/_codegen/compress-map.generated.ts"), "utf8"),
        )
    })
})
