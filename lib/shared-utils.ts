import type { SessionState, WithParts } from "./state/index.js"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    if (msg.info.time.created < state.lastCompaction) {
        return true
    }
    if (state.compressed.messageIds.has(msg.info.id)) {
        return true
    }
    return false
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
