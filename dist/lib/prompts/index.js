// Generated prompts (from .md files via scripts/generate-prompts.ts)
import { FOLD_REQUEST } from "./_codegen/fold-request.generated.js";
export { COMPRESS } from "./_codegen/compress.generated.js";
export function renderFoldRequest(reason) {
    return FOLD_REQUEST.trim().replace("{{reason}}", () => reason);
}
//# sourceMappingURL=index.js.map