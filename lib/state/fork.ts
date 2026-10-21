import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../logger.js"
import { listSessionMessages, type PluginClient } from "../sdk/client.js"
import { loadSessionState, saveSessionState } from "./persistence.js"
import type { SessionState, WithParts } from "./types.js"

/** Carry compression blocks into a V2 fork before its first model request. */
export async function inheritForkCompression(
    session: Plugin.Context["session"],
    client: PluginClient,
    state: SessionState,
    logger: Logger,
    childMessages: WithParts[],
): Promise<void> {
    if (!state.sessionId || state.hasPersistedState) return
    const child = await session.get({ sessionID: state.sessionId })
    if (!child.fork) return

    const parentMessages = (await listSessionMessages(client, child.fork.sessionID)) as WithParts[]
    const parentState = await loadSessionState(child.fork.sessionID, logger, parentMessages)
    if (parentState.status === "error")
        throw new Error("Cannot read parent compression state for fork")
    if (parentState.status === "missing") return

    const boundary = parentMessages.findIndex(
        (message) => message.info.id === child.fork?.boundary.messageID,
    )
    if (boundary < 0) throw new Error("Fork boundary is outside the parent context")
    const parentPrefix = parentMessages
        .slice(0, child.fork.boundary.type === "before" ? boundary : boundary + 1)
        .filter((message) => {
            if (message.info.sourceType === "assistant")
                return message.info.time.completed !== undefined
            if (message.info.sourceType === "shell") return message.info.finish === "stop"
            if (message.info.sourceType === "compaction") {
                return message.info.time.completed !== undefined || message.info.error !== undefined
            }
            return true
        })
    if (childMessages.length < parentPrefix.length) {
        throw new Error("Fork transcript is shorter than its copied parent history")
    }

    const mapped = new Map<string, string>()
    for (let index = 0; index < parentPrefix.length; index++) {
        const parent = parentPrefix[index]
        const forked = childMessages[index]
        if (
            parent.info.sourceType !== forked.info.sourceType ||
            parent.info.time.created !== forked.info.time.created ||
            JSON.stringify(parent.parts) !== JSON.stringify(forked.parts)
        )
            throw new Error("Fork transcript differs from the copied parent history")
        mapped.set(parent.info.id, forked.info.id)
    }

    const messageID = (id: string) => {
        const result = mapped.get(id)
        if (!result)
            throw new Error(`Compression state references a message outside the fork: ${id}`)
        return result
    }
    const summaries = parentState.state.compressSummaries.filter((summary) => {
        const anchor = parentMessages.findIndex(
            (message) => message.info.id === summary.anchorMessageId,
        )
        if (anchor < 0) throw new Error("Parent compression block has no transcript anchor")
        if (anchor > boundary || (anchor === boundary && child.fork?.boundary.type === "before"))
            return false
        if (!mapped.has(summary.anchorMessageId))
            throw new Error("Fork did not copy a compression block anchor")
        return summary.messageIds.every((id) => mapped.has(id))
    })
    const turns = parentState.state.managementTurns.filter((turn) => {
        if (!mapped.has(turn.triggerMessageId)) return false
        return [
            turn.triggeredByMessageId,
            turn.completedMessageId,
            ...(turn.protectedMessageIds ?? []),
        ].every((id) => !id || mapped.has(id))
    })
    // A fork inside a block retains that span as raw history; only complete blocks stay compressed.
    const compressedMessages = new Set(
        summaries.flatMap((summary) => summary.messageIds.map(messageID)),
    )
    const childTools = new Set(
        childMessages
            .slice(0, parentPrefix.length)
            .filter((message) => compressedMessages.has(message.info.id))
            .flatMap((message) =>
                message.parts.flatMap((part) => (part.type === "tool" ? [part.callID] : [])),
            ),
    )
    const candidate: SessionState = {
        ...state,
        compressed: {
            messageIds: new Set(
                parentState.state.compressed.messageIds
                    .filter((id) => mapped.has(id) && compressedMessages.has(messageID(id)))
                    .map(messageID),
            ),
            toolIds: new Set(
                parentState.state.compressed.toolIds.filter((id) => childTools.has(id)),
            ),
        },
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
        stats: { ...parentState.state.stats },
        autoCompressionEnabledOverride: parentState.state.autoCompressionEnabledOverride,
        autoCompressionTokenThresholdOverride:
            parentState.state.autoCompressionTokenThresholdOverride,
        autoCompressionContextWindowRatioOverride:
            parentState.state.autoCompressionContextWindowRatioOverride,
        compressionCooldownAfterMessageId:
            parentState.state.compressionCooldownAfterMessageId &&
            mapped.has(parentState.state.compressionCooldownAfterMessageId)
                ? messageID(parentState.state.compressionCooldownAfterMessageId)
                : undefined,
        lastCompaction: parentState.state.lastCompaction ?? 0,
    }
    if (!(await saveSessionState(candidate, logger)))
        throw new Error("Cannot persist fork compression state")
}
