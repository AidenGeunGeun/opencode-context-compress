// Generated prompts (from .md files via scripts/generate-prompts.ts)
import { SYSTEM as SYSTEM_PROMPT } from "./_codegen/system.generated.js";
import { AUTOMATIC_SYSTEM as AUTOMATIC_SYSTEM_PROMPT } from "./_codegen/automatic-system.generated.js";
import { COMPRESS as COMPRESS_TOOL_SPEC } from "./_codegen/compress.generated.js";
import { SQUASH_SYSTEM as SQUASH_SYSTEM_PROMPT } from "./_codegen/squash-system.generated.js";
import { SQUASH as SQUASH_TOOL_SPEC } from "./_codegen/squash.generated.js";
import { REPORT as REPORT_PROMPT } from "./_codegen/report.generated.js";
import { SQUASH_REPORT as SQUASH_REPORT_PROMPT } from "./_codegen/squash-report.generated.js";
import { POST_COMPRESSION_NOTICE as POST_COMPRESSION_NOTICE_PROMPT } from "./_codegen/post-compression-notice.generated.js";
/**
 * Only the Orchestrator maintains a handoff report file. Fail closed on a missing or
 * different identity so no other agent is pushed toward a file it does not keep.
 */
export function isReportMaintainingAgent(agent) {
    return agent === "orchestrator";
}
/** The Orchestrator-scoped handoff-report block, or an empty string for every other agent. */
export function renderReportInstruction(agent) {
    return isReportMaintainingAgent(agent) ? REPORT_PROMPT.trim() : "";
}
function applyReportBlock(prompt, agent, block) {
    if (isReportMaintainingAgent(agent)) {
        return prompt.replaceAll("{{report_block}}", block.trim());
    }
    return prompt.replace(/\n*\{\{report_block\}\}\n*/g, "\n\n");
}
export function renderSystemPrompt(agent) {
    return applyReportBlock(SYSTEM_PROMPT.trim(), agent, REPORT_PROMPT);
}
export function renderAutomaticSystemPrompt(vars, agent) {
    let prompt = applyReportBlock(AUTOMATIC_SYSTEM_PROMPT.trim(), agent, REPORT_PROMPT);
    for (const [key, value] of Object.entries(vars)) {
        prompt = prompt.replaceAll(`{{${key}}}`, value);
    }
    return prompt;
}
export function renderSquashSystemPrompt(agent) {
    return applyReportBlock(SQUASH_SYSTEM_PROMPT.trim(), agent, SQUASH_REPORT_PROMPT);
}
export function renderPostCompressionNotice() {
    return POST_COMPRESSION_NOTICE_PROMPT.trim();
}
const PROMPTS = {
    "compress-tool-spec": COMPRESS_TOOL_SPEC,
    "squash-tool-spec": SQUASH_TOOL_SPEC,
};
export function loadPrompt(name, vars) {
    let content = PROMPTS[name];
    if (!content) {
        throw new Error(`Prompt not found: ${name}`);
    }
    if (vars) {
        for (const [key, value] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
        }
    }
    return content;
}
//# sourceMappingURL=index.js.map