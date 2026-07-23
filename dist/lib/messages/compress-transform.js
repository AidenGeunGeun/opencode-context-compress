import { isMessageCompacted, getLastUserMessage } from "../shared-utils.js";
import { createSyntheticUserMessage, isIgnoredUserMessage } from "./utils.js";
import { buildLegacyResidueSuppressionPlan } from "./legacy-residue.js";
import { isGoalContinuationMessage } from "../goal.js";
import { formatCompressBlockContent, orderCompressBlocks } from "./blocks.js";
const COMPRESSED_TOOL_OUTPUT_REPLACEMENT = "[Output removed to save context - information superseded or no longer needed]";
const COMPRESSED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]";
const COMPRESSED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]";
export const applyCompressTransforms = (state, logger, messages) => {
    filterCompressedRanges(state, logger, messages);
    stripCompressedTools(state, messages);
    stripToolOutputs(state, messages);
    stripToolInputs(state, messages);
    stripToolErrors(state, messages);
};
function isVisibleUserMessage(message) {
    return message.info.role === "user" && !isIgnoredUserMessage(message) && !isGoalContinuationMessage(message);
}
/**
 * Finds the session's currently open management turn, if any: a turn that is not yet
 * marked completed by a successful `compress` call AND has no later visible user message
 * bounding it. At most one such turn should normally exist - starting a new `/compress
 * manage` (itself a visible user message) or any ordinary reply always bounds the previous
 * one. Picks the most recently triggered candidate defensively in case state is corrupt.
 */
export function findActiveManagementTurn(state, rawMessages) {
    if (!state.managementTurns?.length) {
        return undefined;
    }
    const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]));
    let best;
    for (const turn of state.managementTurns) {
        if (turn.completedAt) {
            continue;
        }
        const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
        if (triggerIndex === undefined) {
            continue;
        }
        let bounded = false;
        for (let i = triggerIndex + 1; i < rawMessages.length; i++) {
            if (isVisibleUserMessage(rawMessages[i])) {
                bounded = true;
                break;
            }
        }
        if (bounded) {
            continue;
        }
        if (!best || triggerIndex > best.triggerIndex) {
            best = { turn, triggerIndex };
        }
    }
    return best;
}
function collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, endExclusive, retainedText, suppressedMessageIds, retainedTextByMessageId) {
    for (let i = triggerIndex; i < endExclusive; i++) {
        const message = rawMessages[i];
        if (i === triggerIndex && retainedText) {
            retainedTextByMessageId.set(message.info.id, retainedText);
            continue;
        }
        suppressedMessageIds.add(message.info.id);
    }
}
export function buildManagementTurnSuppressionPlan(state, rawMessages) {
    const suppressedMessageIds = new Set();
    const retainedTextByMessageId = new Map();
    if (!state.managementTurns?.length) {
        return { suppressedMessageIds, retainedTextByMessageId };
    }
    const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]));
    for (const turn of state.managementTurns) {
        const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
        if (triggerIndex === undefined) {
            continue;
        }
        const retainedText = typeof turn.retainedText === "string" && turn.retainedText.trim().length > 0
            ? turn.retainedText
            : undefined;
        let nextUserIndex = -1;
        for (let i = triggerIndex + 1; i < rawMessages.length; i++) {
            if (isVisibleUserMessage(rawMessages[i])) {
                nextUserIndex = i;
                break;
            }
        }
        if (nextUserIndex !== -1) {
            // Bounded by a real subsequent user turn: this is now history, so the whole
            // span (including any completed compress tool call) can be dropped outright -
            // no provider-protocol pair needs to survive once it is no longer the tail.
            collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, nextUserIndex, retainedText, suppressedMessageIds, retainedTextByMessageId);
            continue;
        }
        // Not yet bounded by a real user message. If a successful `compress` call already
        // completed this turn, apply the atomic-finalize boundary immediately at that tool
        // call's own message instead of waiting for a future user turn.
        const completedIndex = turn.completedAt && turn.completedMessageId
            ? indexByMessageId.get(turn.completedMessageId)
            : undefined;
        if (completedIndex === undefined || completedIndex <= triggerIndex) {
            // Still genuinely in-flight (or an unresolved/foreign marker) - leave the whole
            // turn visible so the agent's own mid-turn tool calls remain usable.
            continue;
        }
        collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, completedIndex, retainedText, suppressedMessageIds, retainedTextByMessageId);
        // Anything strictly after the completion point and before the eventual next real
        // user turn is either the agent's genuine reply (left untouched) or a plugin status
        // notification (ignored user message) that must not linger either.
        for (let i = completedIndex + 1; i < rawMessages.length; i++) {
            const candidate = rawMessages[i];
            if (isVisibleUserMessage(candidate)) {
                break;
            }
            if (candidate.info.role === "user" && isIgnoredUserMessage(candidate)) {
                suppressedMessageIds.add(candidate.info.id);
            }
        }
    }
    return { suppressedMessageIds, retainedTextByMessageId };
}
function createRetainedUserMessage(message, retainedText) {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const textPart = parts.find((part) => part.type === "text");
    const retainedPart = textPart
        ? { ...textPart, text: retainedText }
        : {
            id: `prt_retained_${message.info.id}`,
            sessionID: message.info.sessionID,
            messageID: message.info.id,
            type: "text",
            text: retainedText,
        };
    return {
        ...message,
        parts: [retainedPart],
    };
}
export const transformMessagesForSearch = (rawMessages, state, logger) => {
    // Legacy residue repair runs by content signature alone, independent of persisted
    // `managementTurns`, so it must be checked even when that state is empty, wrong, or
    // incomplete - it is the only thing that can find orphaned artifacts in that case.
    const legacyPlan = buildLegacyResidueSuppressionPlan(rawMessages);
    const hasLegacyFindings = legacyPlan.suppressedMessageIds.size > 0 || legacyPlan.retainedTextByMessageId.size > 0;
    if (!state.compressed.messageIds?.size &&
        !state.compressSummaries.length &&
        !state.managementTurns?.length &&
        !hasLegacyFindings) {
        return {
            transformed: [...rawMessages],
            syntheticMap: new Map(),
        };
    }
    const transformed = [];
    const syntheticMap = new Map();
    const orderedBlocks = orderCompressBlocks(rawMessages, state.compressSummaries);
    const blocksByAnchorId = new Map(orderedBlocks.map((block) => [block.summary.anchorMessageId, block]));
    const managementSuppression = buildManagementTurnSuppressionPlan(state, rawMessages);
    for (const [messageId, retainedText] of legacyPlan.retainedTextByMessageId) {
        if (!managementSuppression.retainedTextByMessageId.has(messageId)) {
            managementSuppression.retainedTextByMessageId.set(messageId, retainedText);
        }
    }
    for (const messageId of legacyPlan.suppressedMessageIds) {
        if (!managementSuppression.retainedTextByMessageId.has(messageId)) {
            managementSuppression.suppressedMessageIds.add(messageId);
        }
    }
    // Retained text always wins, regardless of which side (state-based or legacy-signature)
    // recorded it, or the order the two plans were merged in - an incomplete state-based
    // entry (trigger recorded with no `retainedText`) must not pre-suppress a message that
    // legacy signature scanning later determines has real embedded user text to keep.
    for (const messageId of managementSuppression.retainedTextByMessageId.keys()) {
        managementSuppression.suppressedMessageIds.delete(messageId);
    }
    for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i];
        const msgId = msg.info.id;
        const block = blocksByAnchorId.get(msgId);
        if (block) {
            const summary = block.summary;
            const userMessage = getLastUserMessage(rawMessages, i);
            if (userMessage) {
                const userInfo = userMessage.info;
                const summaryContent = formatCompressBlockContent(block);
                const syntheticMessage = createSyntheticUserMessage(userMessage, summaryContent, userInfo.variant, summary.anchorMessageId);
                transformed.push(syntheticMessage);
                syntheticMap.set(syntheticMessage.info.id, summary);
                logger.info("Injected compress summary", {
                    anchorMessageId: msgId,
                    summaryLength: summary.summary.length,
                });
            }
            else {
                logger.warn("No user message found for compress summary", {
                    anchorMessageId: msgId,
                });
            }
        }
        if (managementSuppression.suppressedMessageIds.has(msgId)) {
            continue;
        }
        const retainedText = managementSuppression.retainedTextByMessageId.get(msgId);
        if (retainedText && !state.compressed.messageIds.has(msgId)) {
            transformed.push(createRetainedUserMessage(msg, retainedText));
            continue;
        }
        if (state.compressed.messageIds.has(msgId)) {
            continue;
        }
        transformed.push(msg);
    }
    return {
        transformed,
        syntheticMap,
    };
};
const stripCompressedTools = (state, messages) => {
    const messagesToRemove = [];
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue;
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        const partsToRemove = [];
        for (const part of parts) {
            if (part.type !== "tool") {
                continue;
            }
            if (!state.compressed.toolIds.has(part.callID)) {
                continue;
            }
            if (part.tool !== "edit" && part.tool !== "write") {
                continue;
            }
            partsToRemove.push(part.callID);
        }
        if (partsToRemove.length === 0) {
            continue;
        }
        msg.parts = parts.filter((part) => part.type !== "tool" || !partsToRemove.includes(part.callID));
        if (msg.parts.length === 0) {
            messagesToRemove.push(msg.info.id);
        }
    }
    if (messagesToRemove.length > 0) {
        const result = messages.filter((msg) => !messagesToRemove.includes(msg.info.id));
        messages.length = 0;
        messages.push(...result);
    }
};
const stripToolOutputs = (state, messages) => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue;
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        for (const part of parts) {
            if (part.type !== "tool") {
                continue;
            }
            if (!state.compressed.toolIds.has(part.callID)) {
                continue;
            }
            if (part.state.status !== "completed") {
                continue;
            }
            if (part.tool === "question" || part.tool === "edit" || part.tool === "write") {
                continue;
            }
            part.state.output = COMPRESSED_TOOL_OUTPUT_REPLACEMENT;
        }
    }
};
const stripToolInputs = (state, messages) => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue;
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        for (const part of parts) {
            if (part.type !== "tool") {
                continue;
            }
            if (!state.compressed.toolIds.has(part.callID)) {
                continue;
            }
            if (part.state.status !== "completed") {
                continue;
            }
            if (part.tool !== "question") {
                continue;
            }
            if (part.state.input?.questions !== undefined) {
                part.state.input.questions = COMPRESSED_QUESTION_INPUT_REPLACEMENT;
            }
        }
    }
};
const stripToolErrors = (state, messages) => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue;
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        for (const part of parts) {
            if (part.type !== "tool") {
                continue;
            }
            if (!state.compressed.toolIds.has(part.callID)) {
                continue;
            }
            if (part.state.status !== "error") {
                continue;
            }
            // Strip all string inputs for errored tools
            const input = part.state.input;
            if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string") {
                        input[key] = COMPRESSED_TOOL_ERROR_INPUT_REPLACEMENT;
                    }
                }
            }
        }
    }
};
const filterCompressedRanges = (state, logger, messages) => {
    const { transformed } = transformMessagesForSearch(messages, state, logger);
    messages.length = 0;
    messages.push(...transformed);
};
//# sourceMappingURL=compress-transform.js.map