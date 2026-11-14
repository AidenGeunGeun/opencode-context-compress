import { listSessionMessages } from "../sdk/client.js";
import { loadSessionState, saveSessionState } from "./persistence.js";
/** Carry compression blocks into a V2 fork before its first model request. */
export async function inheritForkCompression(session, client, state, logger, childMessages) {
    if (!state.sessionId || state.hasPersistedState)
        return;
    const child = await session.get({ sessionID: state.sessionId });
    if (!child.fork)
        return;
    const parentMessages = await listSessionMessages(client, child.fork.sessionID);
    const parentState = await loadSessionState(child.fork.sessionID, logger, parentMessages);
    if (parentState.status === "error")
        throw new Error("Cannot read parent compression state for fork");
    if (parentState.status === "missing")
        return;
    const resolved = await resolveForkBoundary(client, child.fork, parentMessages);
    // A fork from before the parent's latest native compaction holds none of its blocks.
    if (!resolved)
        return;
    const { boundary, before } = resolved;
    const parentPrefix = parentMessages
        .slice(0, before ? boundary : boundary + 1)
        .filter((message) => {
        if (message.info.sourceType === "assistant")
            return message.info.time.completed !== undefined;
        if (message.info.sourceType === "shell")
            return message.info.finish === "stop";
        if (message.info.sourceType === "compaction") {
            return message.info.time.completed !== undefined || message.info.error !== undefined;
        }
        return true;
    });
    if (childMessages.length < parentPrefix.length) {
        throw new Error("Fork transcript is shorter than its copied parent history");
    }
    const mapped = new Map();
    for (let index = 0; index < parentPrefix.length; index++) {
        const parent = parentPrefix[index];
        const forked = childMessages[index];
        if (parent.info.sourceType !== forked.info.sourceType ||
            parent.info.time.created !== forked.info.time.created ||
            JSON.stringify(parent.parts) !== JSON.stringify(forked.parts))
            throw new Error("Fork transcript differs from the copied parent history");
        mapped.set(parent.info.id, forked.info.id);
    }
    const messageID = (id) => {
        const result = mapped.get(id);
        if (!result)
            throw new Error(`Compression state references a message outside the fork: ${id}`);
        return result;
    };
    const summaries = parentState.state.compressSummaries.filter((summary) => {
        const anchor = parentMessages.findIndex((message) => message.info.id === summary.anchorMessageId);
        if (anchor < 0)
            throw new Error("Parent compression block has no transcript anchor");
        if (anchor > boundary || (anchor === boundary && before))
            return false;
        if (!mapped.has(summary.anchorMessageId))
            throw new Error("Fork did not copy a compression block anchor");
        return summary.messageIds.every((id) => mapped.has(id));
    });
    const turns = parentState.state.managementTurns.filter((turn) => {
        if (!mapped.has(turn.triggerMessageId))
            return false;
        return [
            turn.triggeredByMessageId,
            turn.completedMessageId,
            ...(turn.protectedMessageIds ?? []),
        ].every((id) => !id || mapped.has(id));
    });
    // A fork inside a block retains that span as raw history; only complete blocks stay compressed.
    const compressedMessages = new Set(summaries.flatMap((summary) => summary.messageIds.map(messageID)));
    // Tools inside a parent block the fork cut through come back raw, so they lose their marks;
    // pruning marks on the parent's raw tail carry over.
    const parentBlockMessages = new Set(parentState.state.compressSummaries.flatMap((summary) => summary.messageIds.flatMap((id) => mapped.get(id) ?? [])));
    const childTools = new Set(childMessages
        .slice(0, parentPrefix.length)
        .filter((message) => compressedMessages.has(message.info.id) ||
        !parentBlockMessages.has(message.info.id))
        .flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [part.callID] : []))));
    const candidate = {
        ...state,
        compressed: {
            messageIds: new Set(parentState.state.compressed.messageIds
                .filter((id) => mapped.has(id) && compressedMessages.has(messageID(id)))
                .map(messageID)),
            toolIds: new Set(parentState.state.compressed.toolIds.filter((id) => childTools.has(id))),
        },
        // The fork replays the parent's thinking, so it must show Anthropic the same stubs.
        anthropicStubIds: parentState.state.anthropicStubIds &&
            new Set(parentState.state.anthropicStubIds.filter((id) => childTools.has(id))),
        compressSummaries: summaries.map((summary) => ({
            ...summary,
            anchorMessageId: messageID(summary.anchorMessageId),
            messageIds: summary.messageIds.map(messageID),
        })),
        managementTurns: turns.map((turn) => ({
            ...turn,
            triggerMessageId: messageID(turn.triggerMessageId),
            ...(turn.triggeredByMessageId
                ? { triggeredByMessageId: messageID(turn.triggeredByMessageId) }
                : {}),
            ...(turn.completedMessageId
                ? { completedMessageId: messageID(turn.completedMessageId) }
                : {}),
            ...(turn.protectedMessageIds
                ? { protectedMessageIds: turn.protectedMessageIds.map(messageID) }
                : {}),
        })),
        pruneOff: parentState.state.pruneOff,
        tokenThreshold: parentState.state.tokenThreshold,
        lastCompaction: parentState.state.lastCompaction ?? 0,
    };
    if (!(await saveSessionState(candidate, logger)))
        throw new Error("Cannot persist fork compression state");
}
/**
 * A full fork copies through the parent's newest idle marker, which the adapted transcript omits, so
 * such a boundary resolves to the last adapted message before that marker. A boundary missing from the
 * parent's context precedes its latest native compaction and resolves to nothing.
 */
async function resolveForkBoundary(client, fork, parentMessages) {
    const boundary = parentMessages.findIndex((message) => message.info.id === fork.boundary.messageID);
    if (boundary >= 0)
        return { boundary, before: fork.boundary.type === "before" };
    const projected = await client.session.context({ sessionID: fork.sessionID });
    const position = projected.findIndex((value) => value.id === fork.boundary.messageID);
    if (position < 0)
        return;
    const earlier = new Set(projected.slice(0, position).map((value) => value.id));
    return {
        boundary: parentMessages.findLastIndex((message) => earlier.has(message.info.id)),
        before: false,
    };
}
//# sourceMappingURL=fork.js.map