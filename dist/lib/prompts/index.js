// Generated prompts (from .md files via scripts/generate-prompts.ts)
import { SYSTEM as SYSTEM_PROMPT } from "./_codegen/system.generated";
import { COMPRESS as COMPRESS_TOOL_SPEC } from "./_codegen/compress.generated";
import { COMPRESS_MAP as COMPRESS_MAP_TOOL_SPEC } from "./_codegen/compress-map.generated";
function processConditionals(template, flags) {
    const tools = ["compress", "compress_map"];
    let result = template;
    // Strip comments: // ... //
    result = result.replace(/\/\/.*?\/\//g, "");
    // Process tool conditionals
    for (const tool of tools) {
        const regex = new RegExp(`<${tool}>([\\s\\S]*?)</${tool}>`, "g");
        result = result.replace(regex, (_, content) => (flags[tool] ? content : ""));
    }
    // Collapse multiple blank/whitespace-only lines to single blank line
    return result.replace(/\n([ \t]*\n)+/g, "\n\n").trim();
}
export function renderSystemPrompt(flags) {
    return processConditionals(SYSTEM_PROMPT, flags);
}
const PROMPTS = {
    "compress-tool-spec": COMPRESS_TOOL_SPEC,
    "compress-map-tool-spec": COMPRESS_MAP_TOOL_SPEC,
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