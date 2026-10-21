import type { SessionState, WithParts } from "../state/index.js"
import type { Logger } from "../logger.js"
import { isMessageCompacted } from "../shared-utils.js"
import { createSyntheticUserMessage, isIgnoredUserMessage } from "./utils.js"
import { buildLegacyResidueSuppressionPlan } from "./legacy-residue.js"
import { formatCompressBlockContent, orderCompressBlocks } from "./blocks.js"

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

interface V2CleanupPlan extends ManagementTurnSuppressionPlan {
    retainedPartsByMessageId: Map<string, WithParts["parts"]>
    protectedMessageIds: Set<string>
}

function isVisibleUserMessage(message: WithParts): boolean {
    return (
        message.info.role === "user" &&
        (message.info as any).sourceType !== "synthetic" &&
        !isIgnoredUserMessage(message)
    )
}

/**
 * Finds the session's currently open management turn, if any: a turn that is not yet
 * marked completed by a successful `compress` call AND has no later visible user message
 * bounding it. At most one such turn should normally exist - starting a new `/compress
 * manage` (itself a visible user message) or any ordinary reply always bounds the previous
 * one. Picks the most recently triggered candidate defensively in case state is corrupt.
 */
export function findActiveManagementTurn(
    state: SessionState,
    rawMessages: WithParts[],
): { turn: SessionState["managementTurns"][number]; triggerIndex: number } | undefined {
    if (!state.managementTurns?.length) {
        return undefined
    }

    const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]))
    let best: { turn: SessionState["managementTurns"][number]; triggerIndex: number } | undefined

    for (const turn of state.managementTurns) {
        if (turn.completedAt) {
            continue
        }
        const triggerIndex = indexByMessageId.get(turn.triggerMessageId)
        if (triggerIndex === undefined) {
            continue
        }

        let bounded = false
        for (let i = triggerIndex + 1; i < rawMessages.length; i++) {
            if (isVisibleUserMessage(rawMessages[i])) {
                bounded = true
                break
            }
        }
        if (bounded) {
            continue
        }

        if (!best || triggerIndex > best.triggerIndex) {
            best = { turn, triggerIndex }
        }
    }

    return best
}

function collectSuppressedOrRetainedSpan(
    rawMessages: WithParts[],
    triggerIndex: number,
    endExclusive: number,
    retainedText: string | undefined,
    suppressedMessageIds: Set<string>,
    retainedTextByMessageId: Map<string, string>,
): void {
    for (let i = triggerIndex; i < endExclusive; i++) {
        const message = rawMessages[i]
        if (i === triggerIndex && retainedText) {
            retainedTextByMessageId.set(message.info.id, retainedText)
            continue
        }
        suppressedMessageIds.add(message.info.id)
    }
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
        if (turn.cleanupVersion === 2) continue
        const triggerIndex = indexByMessageId.get(turn.triggerMessageId)
        if (triggerIndex === undefined) {
            continue
        }

        const retainedText =
            typeof turn.retainedText === "string" && turn.retainedText.trim().length > 0
                ? turn.retainedText
                : undefined

        let nextUserIndex = -1
        for (let i = triggerIndex + 1; i < rawMessages.length; i++) {
            if (isVisibleUserMessage(rawMessages[i])) {
                nextUserIndex = i
                break
            }
        }

        if (nextUserIndex !== -1) {
            // Bounded by a real subsequent user turn: this is now history, so the whole
            // span (including any completed compress tool call) can be dropped outright -
            // no provider-protocol pair needs to survive once it is no longer the tail.
            collectSuppressedOrRetainedSpan(
                rawMessages,
                triggerIndex,
                nextUserIndex,
                retainedText,
                suppressedMessageIds,
                retainedTextByMessageId,
            )
            continue
        }

        // Not yet bounded by a real user message. If a successful `compress` call already
        // completed this turn, apply the atomic-finalize boundary immediately at that tool
        // call's own message instead of waiting for a future user turn.
        const completedIndex =
            turn.completedAt && turn.completedMessageId
                ? indexByMessageId.get(turn.completedMessageId)
                : undefined

        if (completedIndex === undefined || completedIndex <= triggerIndex) {
            // Still genuinely in-flight (or an unresolved/foreign marker) - leave the whole
            // turn visible so the agent's own mid-turn tool calls remain usable.
            continue
        }

        collectSuppressedOrRetainedSpan(
            rawMessages,
            triggerIndex,
            completedIndex,
            retainedText,
            suppressedMessageIds,
            retainedTextByMessageId,
        )

        // Anything strictly after the completion point and before the eventual next real
        // user turn is either the agent's genuine reply (left untouched) or a plugin status
        // notification (ignored user message) that must not linger either.
        for (let i = completedIndex + 1; i < rawMessages.length; i++) {
            const candidate = rawMessages[i]
            if (isVisibleUserMessage(candidate)) {
                break
            }
            if (candidate.info.role === "user" && isIgnoredUserMessage(candidate)) {
                suppressedMessageIds.add(candidate.info.id)
            }
        }
    }

    return { suppressedMessageIds, retainedTextByMessageId }
}

function completionTool(turn: SessionState["managementTurns"][number]): "compress" | "squash" {
    return turn.source === "squash" ? "squash" : "compress"
}

function withoutCompletionTool(
    message: WithParts,
    turn: SessionState["managementTurns"][number],
): WithParts["parts"] {
    return message.parts.filter(
        (part) => !(part.type === "tool" && part.tool === completionTool(turn)),
    )
}

function buildV2CleanupPlan(
    state: SessionState,
    rawMessages: WithParts[],
): V2CleanupPlan {
    const suppressedMessageIds = new Set<string>()
    const retainedTextByMessageId = new Map<string, string>()
    const retainedPartsByMessageId = new Map<string, WithParts["parts"]>()
    const protectedMessageIds = new Set<string>()
    const turns = state.managementTurns.filter((turn) => turn.cleanupVersion === 2)
    const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]))
    const active = [...turns].reverse().find((turn) => {
        if (turn.completedAt) return false
        const triggerIndex = indexByMessageId.get(turn.triggerMessageId)
        if (triggerIndex === undefined) return false
        return !rawMessages.slice(triggerIndex + 1).some(isVisibleUserMessage)
    })
    const newestCompleted = [...turns].reverse().find(
        (turn) => turn.completedAt && turn.completedMessageId,
    )
    const visibleAnchors = turns.flatMap((turn) =>
        [indexByMessageId.get(turn.triggerMessageId), turn.completedMessageId
            ? indexByMessageId.get(turn.completedMessageId)
            : undefined].filter((index): index is number => index !== undefined),
    )
    const firstV2Index = visibleAnchors.length > 0 ? Math.min(...visibleAnchors) : undefined

    // Once Version 2 is visible, the legacy content scanner must never reinterpret later
    // conversation. V2 removes only persisted plugin-owned IDs and metadata below.
    if (firstV2Index !== undefined) {
        for (let i = firstV2Index; i < rawMessages.length; i++) {
            protectedMessageIds.add(rawMessages[i].info.id)
        }
    }

    for (const turn of turns) {
        const triggerIndex = indexByMessageId.get(turn.triggerMessageId)
        if (triggerIndex !== undefined && turn !== active) {
            if (turn.retainedText) retainedTextByMessageId.set(turn.triggerMessageId, turn.retainedText)
            else suppressedMessageIds.add(turn.triggerMessageId)
        }

        const completedIndex = turn.completedMessageId
            ? indexByMessageId.get(turn.completedMessageId)
            : undefined
        if (completedIndex !== undefined && (active || turn !== newestCompleted)) {
            const message = rawMessages[completedIndex]
            const parts = withoutCompletionTool(message, turn)
            if (parts.length > 0) retainedPartsByMessageId.set(message.info.id, parts)
            else suppressedMessageIds.add(message.info.id)
        }

        if (triggerIndex === undefined) continue
        for (let i = triggerIndex + 1; i < rawMessages.length; i++) {
            const message = rawMessages[i]
            if (isVisibleUserMessage(message)) break
            if (message.info.role === "user" && isIgnoredUserMessage(message)) {
                suppressedMessageIds.add(message.info.id)
                continue
            }
            if (
                turn !== active &&
                !(turn === newestCompleted && message.info.id === turn.completedMessageId)
            ) {
                const parts = withoutCompletionTool(message, turn)
                if (parts.length === message.parts.length) continue
                if (parts.length > 0) retainedPartsByMessageId.set(message.info.id, parts)
                else suppressedMessageIds.add(message.info.id)
            }
        }
    }

    for (const messageId of suppressedMessageIds) protectedMessageIds.delete(messageId)

    return {
        suppressedMessageIds,
        retainedTextByMessageId,
        retainedPartsByMessageId,
        protectedMessageIds,
    }
}

/** Remove exact Version 2 machinery from material selected into a future summary. */
export function stripV2MachineryForCompressionSelection(
    messages: WithParts[],
    state: SessionState,
): WithParts[] {
    const triggers = new Map(
        state.managementTurns
            .filter((turn) => turn.cleanupVersion === 2)
            .map((turn) => [turn.triggerMessageId, turn]),
    )
    const completions = new Map(
        state.managementTurns
            .filter((turn) => turn.cleanupVersion === 2 && turn.completedMessageId)
            .map((turn) => [turn.completedMessageId as string, turn]),
    )

    return messages.flatMap((message) => {
        const trigger = triggers.get(message.info.id)
        if (trigger && !trigger.retainedText) return []

        const completion = completions.get(message.info.id)
        if (!completion) return [message]
        const parts = withoutCompletionTool(message, completion)
        return parts.length > 0 ? [{ ...message, parts }] : []
    })
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
    // Legacy residue repair runs by content signature alone, independent of persisted
    // `managementTurns`, so it must be checked even when that state is empty, wrong, or
    // incomplete - it is the only thing that can find orphaned artifacts in that case.
    const legacyPlan = buildLegacyResidueSuppressionPlan(rawMessages)
    const v2Plan = buildV2CleanupPlan(state, rawMessages)
    const hasLegacyFindings = legacyPlan.suppressedMessageIds.size > 0 || legacyPlan.retainedTextByMessageId.size > 0

    if (
        !state.compressed.messageIds?.size &&
        !state.compressSummaries.length &&
        !state.managementTurns?.length &&
        !hasLegacyFindings &&
        v2Plan.suppressedMessageIds.size === 0 &&
        v2Plan.retainedPartsByMessageId.size === 0
    ) {
        return {
            transformed: [...rawMessages],
            syntheticMap: new Map(),
        }
    }

    const transformed: WithParts[] = []
    const syntheticMap = new Map<string, SessionState["compressSummaries"][number]>()
    const orderedBlocks = orderCompressBlocks(rawMessages, state.compressSummaries)
    const blocksByAnchorId = new Map(
        orderedBlocks.map((block) => [block.summary.anchorMessageId, block]),
    )
    const managementSuppression = buildManagementTurnSuppressionPlan(state, rawMessages)
    for (const [messageId, retainedText] of v2Plan.retainedTextByMessageId) {
        managementSuppression.retainedTextByMessageId.set(messageId, retainedText)
    }
    for (const messageId of v2Plan.suppressedMessageIds) {
        managementSuppression.suppressedMessageIds.add(messageId)
    }
    for (const [messageId, retainedText] of legacyPlan.retainedTextByMessageId) {
        if (!managementSuppression.retainedTextByMessageId.has(messageId)) {
            managementSuppression.retainedTextByMessageId.set(messageId, retainedText)
        }
    }
    for (const messageId of legacyPlan.suppressedMessageIds) {
        if (
            !managementSuppression.retainedTextByMessageId.has(messageId) &&
            !v2Plan.retainedPartsByMessageId.has(messageId) &&
            !v2Plan.protectedMessageIds.has(messageId)
        ) {
            managementSuppression.suppressedMessageIds.add(messageId)
        }
    }
    // Retained text always wins, regardless of which side (state-based or legacy-signature)
    // recorded it, or the order the two plans were merged in - an incomplete state-based
    // entry (trigger recorded with no `retainedText`) must not pre-suppress a message that
    // legacy signature scanning later determines has real embedded user text to keep.
    for (const messageId of managementSuppression.retainedTextByMessageId.keys()) {
        managementSuppression.suppressedMessageIds.delete(messageId)
    }
    for (const messageId of v2Plan.retainedPartsByMessageId.keys()) {
        managementSuppression.suppressedMessageIds.delete(messageId)
    }
    for (const messageId of v2Plan.protectedMessageIds) {
        managementSuppression.suppressedMessageIds.delete(messageId)
    }

    for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i]
        const msgId = msg.info.id

        const block = blocksByAnchorId.get(msgId)
        if (block) {
            const summary = block.summary
            // Anchors identify transcript positions, including system events before any user.
            const syntheticMessage = createSyntheticUserMessage(
                msg,
                formatCompressBlockContent(block),
                msg.info.variant,
                summary.anchorMessageId,
            )
            transformed.push(syntheticMessage)
            syntheticMap.set(syntheticMessage.info.id, summary)

            logger.info("Injected compress summary", {
                anchorMessageId: msgId,
                summaryLength: summary.summary.length,
            })
        }

        const retainedParts = v2Plan.retainedPartsByMessageId.get(msgId)
        if (retainedParts && !state.compressed.messageIds.has(msgId)) {
            transformed.push({ ...msg, parts: retainedParts })
            continue
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

            if (typeof part.state.input === "object" && part.state.input.questions !== undefined) {
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
