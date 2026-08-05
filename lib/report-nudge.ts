import type { PluginConfig } from "./config.js"
import type { Logger } from "./logger.js"
import {
    getAssistantContextTokens,
    type AssistantMessageInfo,
} from "./auto-compression.js"
import { findActiveManagementTurn } from "./messages/compress-transform.js"
import { handleReportCommand } from "./commands/report.js"
import { listSessionMessages } from "./sdk/client.js"
import type { WithParts } from "./state/index.js"
import { SessionStateManager } from "./state/index.js"

export interface ReportNudgeDecision {
    due: boolean
    bucket: number | undefined
}

/**
 * Absolute raw-context trigger over provider-reported usage, the same signal automatic
 * compression uses. Crossing 100k, 200k, and so on advances the bucket and fires once. When
 * compression shrinks the context into a lower bucket, tracking drops with it so those absolute
 * boundaries can fire again as the new context grows. An unusable reading leaves state untouched.
 */
export function resolveReportNudge(
    contextTokens: number,
    previousBucket: number | undefined,
    tokenInterval: number,
): ReportNudgeDecision {
    if (!Number.isFinite(tokenInterval) || tokenInterval <= 0) {
        return { due: false, bucket: previousBucket }
    }
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
        return { due: false, bucket: previousBucket }
    }

    const bucket = Math.floor(contextTokens / tokenInterval)
    const due = bucket > 0 && (previousBucket === undefined || bucket > previousBucket)
    return { due, bucket }
}

export function createReportNudgeEventHandler(
    client: any,
    stateManager: SessionStateManager,
    logger: Logger,
    config: PluginConfig,
) {
    return async (input: { event?: { type?: string; properties?: { info?: AssistantMessageInfo } } }) => {
        if (!config.reportNudge.enabled) return
        if (input.event?.type !== "message.updated") return

        const info = input.event.properties?.info
        if (
            !info ||
            info.role !== "assistant" ||
            info.summary === true ||
            info.error ||
            !info.time?.completed
        ) {
            return
        }

        const state = stateManager.get(info.sessionID)
        let reserved: { state: typeof state; messages: WithParts[] } | undefined
        try {
            reserved = await stateManager.runExclusive(info.sessionID, async () => {
                const contextTokens = getAssistantContextTokens(info.tokens)
                const decision = resolveReportNudge(
                    contextTokens,
                    state.reportNudgeBucket,
                    config.reportNudge.tokenInterval,
                )
                state.reportNudgeBucket = decision.bucket
                if (!decision.due && !state.reportNudgePending) return undefined
                if (state.reportNudgeStarting) return undefined

                state.reportNudgePending = true
                state.reportNudgeStarting = true
                logger.info("Handoff report nudge queued", {
                    sessionId: info.sessionID,
                    messageId: info.id,
                    contextTokens,
                    bucket: decision.bucket,
                    tokenInterval: config.reportNudge.tokenInterval,
                })

                const messages = (await listSessionMessages(client, info.sessionID)) as WithParts[]
                if (messages.length === 0) {
                    throw new Error("session messages were unavailable")
                }
                if (findActiveManagementTurn(state, messages)) {
                    state.reportNudgePending = false
                    state.reportNudgeStarting = false
                    logger.info("Handoff report nudge dropped: compression already requests the update", {
                        sessionId: info.sessionID,
                    })
                    return undefined
                }
                return { state, messages }
            })
        } catch (error: any) {
            state.reportNudgePending = true
            state.reportNudgeStarting = false
            logger.error("Could not prepare the handoff report nudge", {
                sessionId: info.sessionID,
                error: error?.message || String(error),
            })
            return
        }

        if (!reserved) return
        try {
            await handleReportCommand({
                client,
                state: reserved.state,
                logger,
                sessionId: info.sessionID,
                messages: reserved.messages,
            })
        } finally {
            reserved.state.reportNudgeStarting = false
        }
    }
}
