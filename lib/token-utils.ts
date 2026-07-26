import { SessionState, WithParts } from "./state/index.js"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { Logger } from "./logger.js"
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

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: state.variant,
        }
    }
    const userInfo = userMsg.info as UserMessage
    const agent: string = userInfo.agent
    const providerId: string | undefined = userInfo.model.providerID
    const modelId: string | undefined = userInfo.model.modelID
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
