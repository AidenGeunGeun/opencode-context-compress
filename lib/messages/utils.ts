import { ulid } from "ulid"
import { createHash } from "crypto"
import type { WithParts } from "../state/index.js"
import type { UserMessage } from "@opencode-ai/sdk/v2"

export const COMPRESS_SUMMARY_PREFIX = "[Compressed conversation block]\n\n"

const generateUniqueId = (prefix: string): string => `${prefix}_${ulid()}`

const generateStableId = (prefix: string, seed: string): string =>
    `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`

const isGeminiModel = (modelID: string): boolean => {
    const lowerModelID = modelID.toLowerCase()
    return lowerModelID.includes("gemini")
}

export const createSyntheticUserMessage = (
    baseMessage: WithParts,
    content: string,
    variant?: string,
    stableSeed?: string,
): WithParts => {
    const userInfo = baseMessage.info as UserMessage
    const now = stableSeed ? userInfo.time.created : Date.now()
    const messageId = stableSeed ? generateStableId("msg", stableSeed) : generateUniqueId("msg")
    const partId = stableSeed ? generateStableId("prt", stableSeed) : generateUniqueId("prt")

    return {
        info: {
            id: messageId,
            sessionID: userInfo.sessionID,
            role: "user" as const,
            agent: userInfo.agent,
            model: userInfo.model,
            time: { created: now },
            ...(variant !== undefined && { variant }),
        },
        parts: [
            {
                id: partId,
                sessionID: userInfo.sessionID,
                messageID: messageId,
                type: "text" as const,
                text: content,
            },
        ],
    }
}

export const createSyntheticTextPart = (baseMessage: WithParts, content: string) => {
    const userInfo = baseMessage.info as UserMessage
    const partId = generateUniqueId("prt")

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "text" as const,
        text: content,
    }
}

export const createSyntheticToolPart = (
    baseMessage: WithParts,
    content: string,
    modelID: string,
) => {
    const userInfo = baseMessage.info as UserMessage
    const now = Date.now()

    const partId = generateUniqueId("prt")
    const callId = generateUniqueId("call")

    // Gemini requires thoughtSignature bypass to accept synthetic tool parts
    const toolPartMetadata = isGeminiModel(modelID)
        ? { google: { thoughtSignature: "skip_thought_signature_validator" } }
        : {}

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "tool" as const,
        callID: callId,
        tool: "context_info",
        state: {
            status: "completed" as const,
            input: {},
            output: content,
            title: "Context Info",
            metadata: toolPartMetadata,
            time: { start: now, end: now },
        },
    }
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if (!(part as any).ignored) {
            return false
        }
    }

    return true
}

export const findMessageIndex = (messages: WithParts[], messageId: string): number => {
    return messages.findIndex((msg) => msg.info.id === messageId)
}
