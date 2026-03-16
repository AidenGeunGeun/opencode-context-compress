import { isIgnoredUserMessage } from "./messages/utils";
export const isMessageCompacted = (state, msg) => {
    if (msg.info.time.created < state.lastCompaction) {
        return true;
    }
    if (state.compressed.messageIds.has(msg.info.id)) {
        return true;
    }
    return false;
};
export const getLastUserMessage = (messages, startIndex) => {
    const start = startIndex ?? messages.length - 1;
    for (let i = start; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg;
        }
    }
    return null;
};
//# sourceMappingURL=shared-utils.js.map