import { isMessageCompacted } from "../shared-utils";
export async function isSubAgentSession(client, sessionID) {
    try {
        const result = await client.session.get({ path: { id: sessionID } });
        return !!result.data?.parentID;
    }
    catch (error) {
        return false;
    }
}
export function findLastCompactionTimestamp(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role === "assistant" && msg.info.summary === true) {
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
}
//# sourceMappingURL=utils.js.map