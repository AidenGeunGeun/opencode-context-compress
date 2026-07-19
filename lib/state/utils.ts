import type { SessionState, WithParts } from "./types.js"
import { getSession } from "../sdk/client.js"
import { isMessageCompacted } from "../shared-utils.js"

export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await getSession(client, sessionID)
        return !!result?.parentID
    } catch (error: any) {
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

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}

export function resetOnCompaction(state: SessionState): void {
    state.toolParameters.clear()
    state.compressed.toolIds = new Set<string>()
    state.compressed.messageIds = new Set<string>()
    state.compressSummaries = []
    state.managementTurns = []
    state.compressionMapSnapshot = undefined
    state.goalOverflowRecovery = undefined
    state.autoCompressionStarting = false
    state.lastAutoTriggeredMessageId = undefined
}
