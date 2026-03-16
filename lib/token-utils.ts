import { SessionState, WithParts } from "./state"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { Logger } from "./logger"
import { getLastUserMessage, isMessageCompacted } from "./shared-utils"
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

export function extractToolContent(part: any): string[] {
    const contents: string[] = []

    if (part.tool === "question") {
        const questions = part.state?.input?.questions
        if (questions !== undefined) {
            const content = typeof questions === "string" ? questions : JSON.stringify(questions)
            contents.push(content)
        }
        return contents
    }

    if (part.tool === "edit" || part.tool === "write") {
        if (part.state?.input) {
            const inputContent =
                typeof part.state.input === "string"
                    ? part.state.input
                    : JSON.stringify(part.state.input)
            contents.push(inputContent)
        }
    }

    if (part.state?.status === "completed" && part.state?.output) {
        const content =
            typeof part.state.output === "string"
                ? part.state.output
                : JSON.stringify(part.state.output)
        contents.push(content)
    } else if (part.state?.status === "error" && part.state?.error) {
        const content =
            typeof part.state.error === "string"
                ? part.state.error
                : JSON.stringify(part.state.error)
        contents.push(content)
    }

    return contents
}

export function countToolTokens(part: any, providerId?: string): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents, providerId)
}

export const calculateTokensSaved = (
    state: SessionState,
    messages: WithParts[],
    compressedToolIds: string[],
    providerId?: string,
): number => {
    try {
        const contents: string[] = []
        for (const msg of messages) {
            if (isMessageCompacted(state, msg)) {
                continue
            }
            const parts = Array.isArray(msg.parts) ? msg.parts : []
            for (const part of parts) {
                if (part.type !== "tool" || !compressedToolIds.includes(part.callID)) {
                    continue
                }
                contents.push(...extractToolContent(part))
            }
        }
        return estimateTokensBatch(contents, providerId)
    } catch (error: any) {
        return 0
    }
}
