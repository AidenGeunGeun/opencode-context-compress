import { describeError } from "../logger.js";
import { getSession } from "../sdk/client.js";
/**
 * Decided once per session and never re-checked, so a lookup failure here silently commits
 * the session to being treated as a main session for its entire life. Reporting it is the
 * only way to tell that apart from a genuine negative.
 */
export async function isSubAgentSession(client, sessionID, logger) {
    try {
        const result = await getSession(client, sessionID);
        return !!result?.parentID;
    }
    catch (error) {
        logger.error("Could not determine whether this is a subagent session; treating it as a main session", {
            sessionID,
            error: describeError(error),
        });
        return false;
    }
}
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