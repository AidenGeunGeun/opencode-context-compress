// Generated prompts (from .md files via scripts/generate-prompts.ts)
import { SYSTEM as SYSTEM_PROMPT } from "./_codegen/system.generated.js"
import { AUTOMATIC_SYSTEM as AUTOMATIC_SYSTEM_PROMPT } from "./_codegen/automatic-system.generated.js"
import { COMPRESS as COMPRESS_TOOL_SPEC } from "./_codegen/compress.generated.js"
import { SQUASH_SYSTEM as SQUASH_SYSTEM_PROMPT } from "./_codegen/squash-system.generated.js"
import { SQUASH as SQUASH_TOOL_SPEC } from "./_codegen/squash.generated.js"
export function renderSystemPrompt(): string {
    return SYSTEM_PROMPT.trim()
}

export function renderAutomaticSystemPrompt(
    vars: Record<string, string>,
): string {
    let prompt = AUTOMATIC_SYSTEM_PROMPT.trim()
    for (const [key, value] of Object.entries(vars)) {
        prompt = prompt.replaceAll(`{{${key}}}`, value)
    }
    return prompt
}

export function renderSquashSystemPrompt(): string {
    return SQUASH_SYSTEM_PROMPT.trim()
}

const PROMPTS: Record<string, string> = {
    "compress-tool-spec": COMPRESS_TOOL_SPEC,
    "squash-tool-spec": SQUASH_TOOL_SPEC,
}

export function loadPrompt(name: string, vars?: Record<string, string>): string {
    let content = PROMPTS[name]
    if (!content) {
        throw new Error(`Prompt not found: ${name}`)
    }
    if (vars) {
        for (const [key, value] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
        }
    }
    return content
}
