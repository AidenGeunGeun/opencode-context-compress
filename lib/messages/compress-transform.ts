import type { SessionState, WithParts } from "../state/index.js"
import type { Logger } from "../logger.js"
import { isMessageCompacted, getLastUserMessage } from "../shared-utils.js"
import { createSyntheticUserMessage, COMPRESS_SUMMARY_PREFIX, isIgnoredUserMessage } from "./utils.js"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const COMPRESSED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const COMPRESSED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const COMPRESSED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export const applyCompressTransforms = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): void => {
    filterCompressedRanges(state, logger, messages)
    stripCompressedTools(state, messages)
    stripToolOutputs(state, messages)
    stripToolInputs(state, messages)
    stripToolErrors(state, messages)
}

export interface TransformMessagesForSearchResult {
    transformed: WithParts[]
    syntheticMap: Map<string, SessionState["compressSummaries"][number]>
}

interface ManagementTurnSuppressionPlan {
    suppressedMessageIds: Set<string>
    retainedTextByMessageId: Map<string, string>
}

function isVisibleUserMessage(message: WithParts): boolean {
    return message.info.role === "user" && !isIgnoredUserMessage(message)
}

export function buildManagementTurnSuppressionPlan(
    state: SessionState,
    rawMessages: WithParts[],
): ManagementTurnSuppressionPlan {
    const suppressedMessageIds = new Set<string>()
    const retainedTextByMessageId = new Map<string, string>()

    if (!state.managementTurns?.length) {
        return { suppressedMessageIds, retainedTextByMessageId }
    }

    const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]))

    for (const turn of state.managementTurns) {
        const triggerIndex = indexByMessageId.get(turn.triggerMessageId)
        if (triggerIndex === undefined) {
            continue
        }

        let nextUserIndex = -1
        for (let i = triggerIndex + 1; i < rawMessages.length; i++) {
            if (isVisibleUserMessage(rawMessages[i])) {
                nextUserIndex = i
                break
            }
        }

        if (nextUserIndex === -1) {
            continue
        }

        const retainedText =
            typeof turn.retainedText === "string" && turn.retainedText.trim().length > 0
                ? turn.retainedText
                : undefined
        for (let i = triggerIndex; i < nextUserIndex; i++) {
            const message = rawMessages[i]
            if (i === triggerIndex && retainedText) {
                retainedTextByMessageId.set(message.info.id, retainedText)
                continue
            }
            suppressedMessageIds.add(message.info.id)
        }
    }

    return { suppressedMessageIds, retainedTextByMessageId }
}

function createRetainedUserMessage(message: WithParts, retainedText: string): WithParts {
    const parts = Array.isArray(message.parts) ? message.parts : []
    const textPart = parts.find((part) => part.type === "text") as any
    const retainedPart = textPart
        ? { ...textPart, text: retainedText }
        : {
              id: `prt_retained_${message.info.id}`,
              sessionID: message.info.sessionID,
              messageID: message.info.id,
              type: "text" as const,
              text: retainedText,
          }

    return {
        ...message,
        parts: [retainedPart],
    }
}

export const transformMessagesForSearch = (
    rawMessages: WithParts[],
    state: SessionState,
    logger: Logger,
): TransformMessagesForSearchResult => {
    if (!state.compressed.messageIds?.size && !state.managementTurns?.length) {
        return {
            transformed: [...rawMessages],
            syntheticMap: new Map(),
        }
    }

    const transformed: WithParts[] = []
    const syntheticMap = new Map<string, SessionState["compressSummaries"][number]>()
    const summariesByAnchorId = new Map(state.compressSummaries.map((summary) => [summary.anchorMessageId, summary]))
    const managementSuppression = buildManagementTurnSuppressionPlan(state, rawMessages)

    for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i]
        const msgId = msg.info.id

        const summary = summariesByAnchorId.get(msgId)
        if (summary) {
            const userMessage = getLastUserMessage(rawMessages, i)

            if (userMessage) {
                const userInfo = userMessage.info as UserMessage
                const summaryContent = COMPRESS_SUMMARY_PREFIX + summary.summary
                const syntheticMessage = createSyntheticUserMessage(
                    userMessage,
                    summaryContent,
                    userInfo.variant,
                    summary.anchorMessageId,
                )
                transformed.push(syntheticMessage)
                syntheticMap.set(syntheticMessage.info.id, summary)

                logger.info("Injected compress summary", {
                    anchorMessageId: msgId,
                    summaryLength: summary.summary.length,
                })
            } else {
                logger.warn("No user message found for compress summary", {
                    anchorMessageId: msgId,
                })
            }
        }

        if (managementSuppression.suppressedMessageIds.has(msgId)) {
            continue
        }

        const retainedText = managementSuppression.retainedTextByMessageId.get(msgId)
        if (retainedText && !state.compressed.messageIds.has(msgId)) {
            transformed.push(createRetainedUserMessage(msg, retainedText))
            continue
        }

        if (state.compressed.messageIds.has(msgId)) {
            continue
        }

        transformed.push(msg)
    }

    return {
        transformed,
        syntheticMap,
    }
}

const stripCompressedTools = (state: SessionState, messages: WithParts[]): void => {
    const messagesToRemove: string[] = []

    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const partsToRemove: string[] = []

        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.compressed.toolIds.has(part.callID)) {
                continue
            }
            if (part.tool !== "edit" && part.tool !== "write") {
                continue
            }

            partsToRemove.push(part.callID)
        }

        if (partsToRemove.length === 0) {
            continue
        }

        msg.parts = parts.filter(
            (part) => part.type !== "tool" || !partsToRemove.includes(part.callID),
        )

        if (msg.parts.length === 0) {
            messagesToRemove.push(msg.info.id)
        }
    }

    if (messagesToRemove.length > 0) {
        const result = messages.filter((msg) => !messagesToRemove.includes(msg.info.id))
        messages.length = 0
        messages.push(...result)
    }
}

const stripToolOutputs = (state: SessionState, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.compressed.toolIds.has(part.callID)) {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }
            if (part.tool === "question" || part.tool === "edit" || part.tool === "write") {
                continue
            }

            part.state.output = COMPRESSED_TOOL_OUTPUT_REPLACEMENT
        }
    }
}

const stripToolInputs = (state: SessionState, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.compressed.toolIds.has(part.callID)) {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }
            if (part.tool !== "question") {
                continue
            }

            if (part.state.input?.questions !== undefined) {
                part.state.input.questions = COMPRESSED_QUESTION_INPUT_REPLACEMENT
            }
        }
    }
}

const stripToolErrors = (state: SessionState, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.compressed.toolIds.has(part.callID)) {
                continue
            }
            if (part.state.status !== "error") {
                continue
            }

            // Strip all string inputs for errored tools
            const input = part.state.input
            if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string") {
                        input[key] = COMPRESSED_TOOL_ERROR_INPUT_REPLACEMENT
                    }
                }
            }
        }
    }
}

const filterCompressedRanges = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): void => {
    const { transformed } = transformMessagesForSearch(messages, state, logger)
    messages.length = 0
    messages.push(...transformed)
}
