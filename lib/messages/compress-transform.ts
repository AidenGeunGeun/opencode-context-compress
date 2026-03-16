import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import { isMessageCompacted, getLastUserMessage } from "../shared-utils"
import { createSyntheticUserMessage, COMPRESS_SUMMARY_PREFIX } from "./utils"
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

export const transformMessagesForSearch = (
    rawMessages: WithParts[],
    state: SessionState,
    logger: Logger,
): TransformMessagesForSearchResult => {
    if (!state.compressed.messageIds?.size) {
        return {
            transformed: [...rawMessages],
            syntheticMap: new Map(),
        }
    }

    const transformed: WithParts[] = []
    const syntheticMap = new Map<string, SessionState["compressSummaries"][number]>()
    const summariesByAnchorId = new Map(state.compressSummaries.map((summary) => [summary.anchorMessageId, summary]))

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
