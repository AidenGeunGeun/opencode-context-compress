import { getSession } from "../sdk/client.js";
import { isMessageCompacted } from "../shared-utils.js";
export async function isSubAgentSession(client, sessionID) {
    try {
        const result = await getSession(client, sessionID);
        return !!result?.parentID;
    }
    catch (error) {
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
export function countTurns(state, messages) {
    let turnCount = 0;
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue;
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++;
            }
        }
    }
    return turnCount;
}
export function resetOnCompaction(state) {
    state.toolParameters.clear();
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