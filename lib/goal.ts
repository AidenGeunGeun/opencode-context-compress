import { getSessionGoal, resumeSessionGoal, type SessionGoalOwner } from "./sdk/client.js"

export interface GoalOverflowRecovery extends SessionGoalOwner {
    overflowMessageId: string
}

const CONTINUATION_PREFIX = "Continue pursuing the active session goal."
const GOAL_REFERENCE = /^Goal reference: goa_\S+ \d+$/m

export function isGoalContinuationMessage(message: {
    info: { role: string }
    parts: unknown[]
}): boolean {
    if (message.info.role !== "user" || !Array.isArray(message.parts)) return false
    return message.parts.some((part) => {
        if (!part || typeof part !== "object") return false
        const value = part as { type?: unknown; text?: unknown; synthetic?: unknown }
        return (
            value.type === "text" &&
            value.synthetic === true &&
            typeof value.text === "string" &&
            value.text.startsWith(CONTINUATION_PREFIX) &&
            GOAL_REFERENCE.test(value.text)
        )
    })
}

export function isContextOverflowError(error: unknown): boolean {
    return !!error && typeof error === "object" && "name" in error && error.name === "ContextOverflowError"
}

export function renderGoalOverflowRecoveryPrompt(): string {
    return [
        "<system-reminder>",
        "CONTEXT OVERFLOW RECOVERY REQUIRED",
        "The unchanged active session Goal was blocked because its provider turn exceeded the context window.",
        "This is one bounded recovery attempt. Review the conversation, then call compress once with one faithful summary and short topic.",
        "The plugin preserves the newest configured execution steps and compresses all eligible earlier history after the newest existing block.",
        "If the call fails, stop and surface the exact failure. Do not retry compression and do not change Goal state yourself.",
        "After durable compression, the plugin will resume only the exact blocked Goal version that caused this recovery.",
        "</system-reminder>",
    ].join("\n")
}

export async function recoverGoalAfterCompression(
    client: unknown,
    sessionId: string,
    recovery: GoalOverflowRecovery,
): Promise<"resumed" | "changed" | "unavailable"> {
    const current = await getSessionGoal(client, sessionId)
    if (current === undefined) return "unavailable"
    if (
        !current ||
        current.status !== "blocked" ||
        current.id !== recovery.goalID ||
        current.time.updated !== recovery.timeUpdated
    ) {
        return "changed"
    }

    try {
        const resumed = await resumeSessionGoal(client, sessionId, recovery)
        return resumed ? "resumed" : "unavailable"
    } catch (error) {
        const latest = await getSessionGoal(client, sessionId)
        if (
            latest !== undefined &&
            (!latest ||
                latest.status !== "blocked" ||
                latest.id !== recovery.goalID ||
                latest.time.updated !== recovery.timeUpdated)
        ) {
            return "changed"
        }
        throw error
    }
}
