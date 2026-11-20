export const isMessageCompacted = (state, msg) => {
    if (msg.info.time.created < state.lastCompaction) {
        return true;
    }
    if (state.compressed.messageIds.has(msg.info.id)) {
        return true;
    }
    return false;
};
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=shared-utils.js.map