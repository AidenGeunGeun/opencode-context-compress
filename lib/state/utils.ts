import type { SessionState, WithParts } from "./types.js"

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
