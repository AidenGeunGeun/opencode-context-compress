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
import { REPORT } from "../lib/prompts/_codegen/report.generated.ts"
import { SQUASH_REPORT } from "../lib/prompts/_codegen/squash-report.generated.ts"
import { POST_COMPRESSION_NOTICE } from "../lib/prompts/_codegen/post-compression-notice.generated.ts"
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

    it("keeps range selection isolated to the explicit squash prompts", () => {
        const system = renderSquashSystemPrompt()
        const tool = loadPrompt("squash-tool-spec")
        for (const output of [system, tool]) {
            assert.match(output, /explicitly ran|current user's `\/compress squash`/i)
            assert.match(output, /contiguous inclusive range/i)
            assert.match(output, /at least two existing compressed blocks/i)
            assert.match(output, /lossy compression of summaries/i)
            assert.match(output, /hidden original messages are unavailable/i)
            assert.match(output, /out-of-range blocks remain unchanged/i)
            assert.match(output, /Do not (?:make a second squash|call squash or compress again)/i)
        }
        assert.match(system, /`\[bN\]` values are current positional labels/i)
        assert.match(system, /newer out-of-range evidence/i)
        assert.match(system, /Call `squash` once with `from`, `to`, `summary`, and `topic`/)
    })

    it("keeps generated prompt sources synchronized and free of retired workflow text", () => {
        const root = process.cwd()
        const systemSource = readFileSync(join(root, "lib/prompts/system.md"), "utf8")
        const automaticSource = readFileSync(
            join(root, "lib/prompts/automatic-system.md"),
            "utf8",
        )
        const compressSource = readFileSync(join(root, "lib/prompts/compress.md"), "utf8")
        const squashSystemSource = readFileSync(join(root, "lib/prompts/squash-system.md"), "utf8")
        const squashSource = readFileSync(join(root, "lib/prompts/squash.md"), "utf8")
        const reportSource = readFileSync(join(root, "lib/prompts/report.md"), "utf8")
        const noticeSource = readFileSync(
            join(root, "lib/prompts/post-compression-notice.md"),
            "utf8",
        )
        assert.equal(REPORT, reportSource)
        assert.equal(POST_COMPRESSION_NOTICE, noticeSource)
        assert.equal(POST_COMPRESSION_NOTICE.trim(), renderPostCompressionNotice())
        assert.equal(SYSTEM, systemSource)
        assert.equal(AUTOMATIC_SYSTEM, automaticSource)
        assert.equal(COMPRESS, compressSource)
        assert.equal(SQUASH_SYSTEM, squashSystemSource)
        assert.equal(SQUASH, squashSource)
        assert.equal(
            SYSTEM.trim().replace("\n{{report_block}}\n", ""),
            renderSystemPrompt(),
        )
        assert.equal(
            SYSTEM.trim().replace("{{report_block}}", REPORT.trim()),
            renderSystemPrompt("orchestrator"),
        )
        assert.equal(COMPRESS.trim(), loadPrompt("compress-tool-spec").trim())
        assert.equal(
            SQUASH_SYSTEM.trim().replace(/\n*\{\{report_block\}\}\n*/g, "\n\n"),
            renderSquashSystemPrompt(),
        )
        assert.equal(
            SQUASH_SYSTEM.trim().replace("{{report_block}}", SQUASH_REPORT.trim()),
            renderSquashSystemPrompt("orchestrator"),
        )
        assert.equal(SQUASH.trim(), loadPrompt("squash-tool-spec").trim())
        for (const generated of [SYSTEM, AUTOMATIC_SYSTEM, COMPRESS]) {
            assert.doesNotMatch(generated, RETIRED_WORKFLOW)
        }
        assert.throws(() => loadPrompt("compress-map-tool-spec"), /Prompt not found/)
    })

    const compressionPrompts = (agent?: string) => [
        renderSystemPrompt(agent),
        renderAutomaticSystemPrompt(
            {
                context_tokens: "1",
                threshold_tokens: "2",
                threshold_reason: "test",
            },
            agent,
        ),
        renderGoalOverflowRecoveryPrompt(agent),
    ]

    it("requires the orchestrator to bring its report up to date before compressing", () => {
        for (const output of compressionPrompts("orchestrator")) {
            assert.match(output, /handoff report file/i)
            assert.match(output, /required step of this turn, not a suggestion/i)
            assert.match(output, /before the `compress` call/i)
            assert.match(output, /same fidelity the summary is held to/i)
            assert.match(output, /cite the report's path/i)
            assert.match(output, /Do not restate the file/i)
            assert.doesNotMatch(output, /\{\{report_block\}\}/)
        }
    })

    it("omits the handoff-report instruction for other agents and for a missing identity", () => {
        for (const agent of [undefined, "pm", "investigator", "Orchestrator"]) {
            for (const output of compressionPrompts(agent)) {
                assert.equal(output.includes(REPORT.trim()), false)
                assert.doesNotMatch(output, /handoff report|report file|report's path/i)
                assert.doesNotMatch(output, /bring it up to date|restate the file/i)
                assert.doesNotMatch(output, /\{\{report_block\}\}/)
            }
        }
    })

    it("scopes the squash handoff-report instruction to the orchestrator", () => {
        const orchestrator = renderSquashSystemPrompt("orchestrator")
        assert.match(orchestrator, /handoff report file/i)
        assert.match(orchestrator, /before squashing/i)
        assert.doesNotMatch(orchestrator, /\{\{report_block\}\}/)

        for (const agent of [undefined, "pm", "investigator", "Orchestrator"]) {
            const output = renderSquashSystemPrompt(agent)
            assert.equal(output.includes(SQUASH_REPORT.trim()), false)
            assert.doesNotMatch(output, /handoff report|report file/i)
            assert.doesNotMatch(output, /\{\{report_block\}\}/)
        }
    })

    it("puts the orchestrator's report instruction ahead of the compress call", () => {
        const output = renderSystemPrompt("orchestrator")
        assert.ok(output.indexOf("Handoff report:") < output.indexOf("Call `compress` once"))
    })

    it("no longer carries the post-compression reread instruction in any compression prompt", () => {
        for (const agent of [undefined, "orchestrator"]) {
            for (const output of compressionPrompts(agent)) {
                assert.doesNotMatch(output, /re-read the relevant task/i)
                assert.doesNotMatch(output, /do not assume the summary preserved everything/i)
            }
        }
    })

    it("delivers the reread instruction through the transient notice instead", () => {
        const output = renderPostCompressionNotice()
        assert.match(output, /context was compressed/i)
        assert.match(output, /re-read the relevant task, spec, report, and project documentation/i)
        assert.match(output, /do not assume the summary preserved everything/i)
        assert.match(output, /continue the original task/i)
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
