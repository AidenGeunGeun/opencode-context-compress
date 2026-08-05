import type { PluginConfig } from "./config.js"
import type { Logger } from "./logger.js"
import {
    getAssistantContextTokens,
    type AssistantMessageInfo,
} from "./auto-compression.js"
import { findActiveManagementTurn } from "./messages/compress-transform.js"
import { createSyntheticTextPart, isIgnoredUserMessage } from "./messages/utils.js"
import { renderReportNudgePrompt } from "./prompts/index.js"
import type { SessionState, WithParts } from "./state/index.js"
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
        const decision = resolveReportNudge(
            getAssistantContextTokens(info.tokens),
            state.reportNudgeBucket,
            config.reportNudge.tokenInterval,
        )
        state.reportNudgeBucket = decision.bucket
        if (!decision.due) return

        state.reportNudgePending = true
        logger.info("Handoff report nudge queued", {
            sessionId: info.sessionID,
            messageId: info.id,
            contextTokens: getAssistantContextTokens(info.tokens),
            bucket: decision.bucket,
            tokenInterval: config.reportNudge.tokenInterval,
        })
    }
}

function findLastVisibleUserMessage(messages: WithParts[]): WithParts | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.info.role === "user" && !isIgnoredUserMessage(message)) {
            return message
        }
    }
    return undefined
}

/**
 * Rides along with a request the session was making anyway rather than opening its own turn.
 * Delivered once per crossing: a missed nudge is picked up by the next interval or by the
 * pre-compression check, and re-delivering every step would nag through a whole tool loop.
 */
export function injectReportNudge(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): boolean {
    if (!state.reportNudgePending) return false

    // Every management prompt - manual, automatic, squash, and Goal overflow recovery - carries
    // the same instruction, so the queued nudge is spent rather than deferred; deferring would
    // land it again as a duplicate once the management turn finished.
    if (findActiveManagementTurn(state, messages)) {
        state.reportNudgePending = false
        logger.info("Handoff report nudge dropped: compression already requests the update", {
            sessionID: messages[0]?.info.sessionID,
        })
        return false
    }

    const target = findLastVisibleUserMessage(messages)
    if (!target) return false

    target.parts = [...target.parts, createSyntheticTextPart(target, renderReportNudgePrompt())]
    state.reportNudgePending = false
    logger.info("Handoff report nudge delivered", {
        sessionID: target.info.sessionID,
        messageID: target.info.id,
    })
    return true
}
