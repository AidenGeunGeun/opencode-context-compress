import type { SessionState, WithParts } from "./state/index.js"
import { getLastUserMessage } from "./shared-utils.js"
import { countTokens as anthropicCountTokens } from "@anthropic-ai/tokenizer"
import { encodingForModel, type Tiktoken } from "js-tiktoken"

// Lazy-initialized tiktoken encoder (created on first non-Anthropic call)
let _tiktokenEncoder: Tiktoken | null = null
function getTiktokenEncoder(): Tiktoken {
    if (!_tiktokenEncoder) {
        _tiktokenEncoder = encodingForModel("gpt-4o")
    }
    return _tiktokenEncoder
}

export function isAnthropicProvider(providerId: string | undefined): boolean {
    if (!providerId) return false
    return providerId.toLowerCase().includes("anthropic")
}

export function getCurrentProviderId(
    state: SessionState,
    messages: WithParts[],
): string | undefined {
    return getLastUserMessage(messages)?.info.model?.providerID ?? state.modelContext?.providerId
}

export function countTokens(text: string, providerId?: string): number {
    if (!text) return 0
    try {
        if (isAnthropicProvider(providerId)) {
            return anthropicCountTokens(text)
        }
        return getTiktokenEncoder().encode(text).length
    } catch {
        // Fallback to heuristic if tokenizers fail
        return Math.ceil(text.length / 4)
    }
}

export function estimateTokensBatch(texts: string[], providerId?: string): number {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "), providerId)
}
