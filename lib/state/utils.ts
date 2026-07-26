import type { Logger } from "../logger.js"
import type { SessionState, WithParts } from "./types.js"
import { getSession } from "../sdk/client.js"

/**
 * Decided once per session and never re-checked, so a lookup failure here silently commits
 * the session to being treated as a main session for its entire life. Reporting it is the
 * only way to tell that apart from a genuine negative.
 */
export async function isSubAgentSession(
    client: any,
    sessionID: string,
    logger: Logger,
): Promise<boolean> {
    try {
        const result = await getSession(client, sessionID)
        return !!result?.parentID
    } catch (error: any) {
        logger.error("Could not determine whether this is a subagent session; treating it as a main session", {
            sessionID,
            error: error instanceof Error ? error.message : String(error),
        })
        return false
    }
}

export function isCompletedNativeCompaction(message: WithParts): boolean {
    const info = message.info
    return info.role === "assistant" && info.summary === true && !!info.finish && !info.error
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (isCompletedNativeCompaction(msg)) {
            return msg.info.time.created
        }
    }
    return 0
}

export function resetOnCompaction(state: SessionState): void {
    state.compressed.toolIds = new Set<string>()
    state.compressed.messageIds = new Set<string>()
    state.compressSummaries = []
    state.managementTurns = []
    state.compressionMapSnapshot = undefined
    state.goalOverflowRecovery = undefined
    state.autoCompressionStarting = false
    state.lastAutoTriggeredMessageId = undefined
}
