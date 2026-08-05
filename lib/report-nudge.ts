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
    baselineTokens: number | undefined
}

/**
 * Growth-based trigger over provider-reported usage, the same signal automatic compression
 * uses. A reading below the baseline means compression (or a native compaction) just shrank the
 * context, so the window restarts from the new floor instead of silently swallowing a full
 * interval. An unusable reading leaves the baseline untouched, so a session that starts without
 * usage numbers still measures its first interval from real growth.
 */
export function resolveReportNudge(
    contextTokens: number,
    baselineTokens: number | undefined,
    tokenInterval: number,
): ReportNudgeDecision {
    if (!Number.isFinite(tokenInterval) || tokenInterval <= 0) {
        return { due: false, baselineTokens }
    }
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
        return { due: false, baselineTokens }
    }
    if (baselineTokens === undefined || contextTokens < baselineTokens) {
        return { due: false, baselineTokens: contextTokens }
    }
    if (contextTokens - baselineTokens < tokenInterval) {
        return { due: false, baselineTokens }
    }
    return { due: true, baselineTokens: contextTokens }
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
            state.reportNudgeBaselineTokens,
            config.reportNudge.tokenInterval,
        )
        state.reportNudgeBaselineTokens = decision.baselineTokens
        if (!decision.due) return

        state.reportNudgePending = true
        logger.info("Handoff report nudge queued", {
            sessionId: info.sessionID,
            messageId: info.id,
            contextTokens: decision.baselineTokens,
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
