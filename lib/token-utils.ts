import type { SessionState, WithParts } from "./state/index.js"
import type { UserMessage } from "./state/types.js"
import type { Logger } from "./logger.js"
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

export interface CurrentParams {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
}

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): CurrentParams {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: state.modelContext?.providerId,
            modelId: state.modelContext?.modelId,
            agent: state.currentAgent,
            variant: state.variant,
        }
    }
    const userInfo = userMsg.info as UserMessage & {
        agent?: string
        model?: { providerID?: string; modelID?: string }
    }
    const agent = userInfo.agent ?? state.currentAgent
    const providerId = userInfo.model?.providerID ?? state.modelContext?.providerId
    const modelId = userInfo.model?.modelID ?? state.modelContext?.modelId
    const variant: string | undefined = state.variant ?? userInfo.variant

    return { providerId, modelId, agent, variant }
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
