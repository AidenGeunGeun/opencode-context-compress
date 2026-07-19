import { isIgnoredUserMessage } from "./messages/utils.js";
import { isGoalContinuationMessage } from "./goal.js";
export const POST_COMPRESSION_COOLDOWN_RESPONSES = 3;
export function resolveEffectiveAutoCompressionPolicy(config, state) {
    const enabledOverride = state.autoCompressionEnabledOverride;
    const tokenThresholdOverride = state.autoCompressionTokenThresholdOverride;
    const contextWindowRatioOverride = state.autoCompressionContextWindowRatioOverride;
    return {
        globallyEnabled: config.enabled,
        enabled: config.enabled && (enabledOverride ?? config.enabled),
        enabledSource: config.enabled && enabledOverride !== undefined ? "session override" : "config",
        tokenThreshold: tokenThresholdOverride ?? config.tokenThreshold,
        tokenThresholdSource: tokenThresholdOverride !== undefined ? "session override" : "config",
        contextWindowRatio: contextWindowRatioOverride ?? config.contextWindowRatio,
        contextWindowRatioSource: contextWindowRatioOverride !== undefined ? "session override" : "config",
    };
}
export function messageContainsCompressCall(message) {
    return !!message?.parts?.some((part) => part.type === "tool" && part.tool === "compress");
}
function isVisibleUserMessage(message) {
    return message.info.role === "user" && !isIgnoredUserMessage(message) && !isGoalContinuationMessage(message);
}
function collectManagementTurnMessageIds(state, messages) {
    const managementMessageIds = new Set();
    const indexByMessageId = new Map(messages.map((message, index) => [message.info.id, index]));
    for (const turn of state.managementTurns) {
        const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
        if (triggerIndex === undefined)
            continue;
        const completedIndex = turn.completedAt && turn.completedMessageId
            ? indexByMessageId.get(turn.completedMessageId)
            : undefined;
        let endExclusive;
        if (completedIndex !== undefined && completedIndex > triggerIndex) {
            endExclusive = completedIndex + 1;
        }
        else {
            endExclusive = messages.length;
            for (let i = triggerIndex + 1; i < messages.length; i++) {
                if (isVisibleUserMessage(messages[i])) {
                    endExclusive = i;
                    break;
                }
            }
        }
        for (let i = triggerIndex; i < endExclusive; i++) {
            managementMessageIds.add(messages[i].info.id);
        }
    }
    return managementMessageIds;
}
export function getPostCompressionCooldownRemaining(state, messages) {
    const anchorMessageId = state.compressionCooldownAfterMessageId;
    if (!anchorMessageId || state.isSubAgent)
        return 0;
    const anchorIndex = messages.findIndex((message) => message.info.id === anchorMessageId);
    if (anchorIndex === -1)
        return 0;
    const eligibleMessageIds = collectEligibleCooldownMessageIds(state, messages, anchorIndex);
    return Math.max(0, POST_COMPRESSION_COOLDOWN_RESPONSES - eligibleMessageIds.length);
}
function collectEligibleCooldownMessageIds(state, messages, anchorIndex) {
    const managementMessageIds = collectManagementTurnMessageIds(state, messages);
    const seen = new Set();
    const eligibleMessageIds = [];
    for (let i = anchorIndex + 1; i < messages.length; i++) {
        const message = messages[i];
        const info = message.info;
        if (info.role !== "assistant" ||
            info.summary === true ||
            info.error ||
            !info.time?.completed ||
            managementMessageIds.has(info.id)) {
            continue;
        }
        if (!seen.has(info.id)) {
            seen.add(info.id);
            eligibleMessageIds.push(info.id);
        }
    }
    return eligibleMessageIds;
}
export function isMessageWithinPostCompressionCooldown(state, messages, messageId) {
    const anchorMessageId = state.compressionCooldownAfterMessageId;
    if (!anchorMessageId || state.isSubAgent)
        return false;
    const anchorIndex = messages.findIndex((message) => message.info.id === anchorMessageId);
    if (anchorIndex === -1)
        return false;
    const eligibleMessageIds = collectEligibleCooldownMessageIds(state, messages, anchorIndex);
    const messagePosition = eligibleMessageIds.indexOf(messageId);
    if (messagePosition !== -1) {
        return messagePosition < POST_COMPRESSION_COOLDOWN_RESPONSES;
    }
    return eligibleMessageIds.length < POST_COMPRESSION_COOLDOWN_RESPONSES;
}
//# sourceMappingURL=auto-policy.js.map