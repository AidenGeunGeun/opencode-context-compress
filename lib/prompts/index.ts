// Generated prompts (from .md files via scripts/generate-prompts.ts)
import { FOLD_DOCUMENTATION } from "./_codegen/fold-documentation.generated.js"
import { FOLD_DOCUMENTATION_SUBAGENT } from "./_codegen/fold-documentation-subagent.generated.js"
import { FOLD_REQUEST } from "./_codegen/fold-request.generated.js"

export { COMPRESS } from "./_codegen/compress.generated.js"

/** A subagent hands its findings to its parent instead of editing documentation, which the parent owns. */
export function renderFoldRequest(reason: string, subagent: boolean): string {
    const documentation = subagent ? FOLD_DOCUMENTATION_SUBAGENT : FOLD_DOCUMENTATION
    return FOLD_REQUEST.trim()
        .replace("{{reason}}", () => reason)
        .replace("{{documentation}}", () => documentation.trim())
}
