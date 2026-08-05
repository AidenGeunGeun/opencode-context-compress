export function isCompletedNativeCompaction(message) {
    const info = message.info;
    return info.role === "assistant" && info.summary === true && !!info.finish && !info.error;
}
export function findLastCompactionTimestamp(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (isCompletedNativeCompaction(msg)) {
            return msg.info.time.created;
        }
    }
    return 0;
}
export function resetOnCompaction(state) {
    state.compressed.toolIds = new Set();
    state.compressed.messageIds = new Set();
    state.compressSummaries = [];
    state.managementTurns = [];
    state.compressionMapSnapshot = undefined;
    state.goalOverflowRecovery = undefined;
    state.autoCompressionStarting = false;
    state.lastAutoTriggeredMessageId = undefined;
}
//# sourceMappingURL=utils.js.map