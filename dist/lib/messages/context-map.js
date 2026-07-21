import { transformMessagesForSearch } from "./compress-transform.js";
function deriveProtectedTailMessageIds(messages, protectedTurns) {
    if (protectedTurns <= 0 || messages.length === 0)
        return [];
    let protectedStart = 0;
    let stepCount = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        protectedStart = index;
        const parts = Array.isArray(messages[index].parts) ? messages[index].parts : [];
        stepCount += parts.filter((part) => part.type === "step-start").length;
        if (stepCount >= protectedTurns)
            break;
    }
    if (stepCount === 0) {
        protectedStart = Math.max(0, messages.length - protectedTurns);
    }
    return messages.slice(protectedStart).map((message) => message.info.id);
}
/**
 * Select every uncompressed physical message after the newest durable block, while
 * preserving the configured newest execution steps verbatim.
 */
export function selectDeterministicCompressionSpan(rawHistory, state, logger, protectedTurns) {
    const { transformed, syntheticMap } = transformMessagesForSearch(rawHistory, state, logger);
    const representedBlockAnchors = new Set([...syntheticMap.values()].map((summary) => summary.anchorMessageId));
    const missingBlock = state.compressSummaries.find((summary) => !representedBlockAnchors.has(summary.anchorMessageId));
    if (missingBlock) {
        throw new Error("compress could not reconcile an existing compressed block with the current transcript. Nothing was compressed.");
    }
    let newestBlockIndex = -1;
    for (let index = transformed.length - 1; index >= 0; index--) {
        if (syntheticMap.has(transformed[index].info.id)) {
            newestBlockIndex = index;
            break;
        }
    }
    const existingBlockMessageIds = new Set();
    for (const summary of state.compressSummaries) {
        existingBlockMessageIds.add(summary.anchorMessageId);
        for (const messageId of summary.messageIds)
            existingBlockMessageIds.add(messageId);
    }
    const candidates = transformed
        .slice(newestBlockIndex + 1)
        .filter((message) => !syntheticMap.has(message.info.id) &&
        !existingBlockMessageIds.has(message.info.id));
    const protectedMessageIds = deriveProtectedTailMessageIds(candidates, protectedTurns);
    const protectedIds = new Set(protectedMessageIds);
    const messages = candidates.filter((message) => !protectedIds.has(message.info.id));
    return {
        messages,
        messageIds: messages.map((message) => message.info.id),
        protectedMessageIds,
    };
}
export function deriveAutomaticProtectedTail(rawMessages, state, logger, protectedTurns) {
    const span = selectDeterministicCompressionSpan(rawMessages, state, logger, protectedTurns);
    return {
        protectedMessageIds: span.protectedMessageIds,
        hasSelectableMessages: span.messageIds.length > 0,
    };
}
//# sourceMappingURL=context-map.js.map