import type { PluginConfig } from "./config.js"
import { describeError, type Logger } from "./logger.js"
import {
    getAssistantContextTokens,
    type AssistantMessageInfo,
} from "./auto-compression.js"
import { renderReportNudgePrompt } from "./prompts/index.js"
import { promptSessionAsync } from "./sdk/client.js"
import { SessionStateManager } from "./state/index.js"

export interface ReportNudgeDecision {
    due: boolean
    bucket: number | undefined
}

/**
 * Absolute raw-context trigger over provider-reported usage, the same signal automatic
 * compression uses. Crossing each configured absolute boundary advances the bucket and fires once.
 * When compression shrinks the context into a lower bucket, tracking drops with it so those
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
    const due = previousBucket !== undefined && bucket > previousBucket
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
            info.agent !== "orchestrator" ||
            info.summary === true ||
            info.error ||
            !info.time?.completed
        ) {
            return
        }

        const state = stateManager.get(info.sessionID)
        const contextTokens = getAssistantContextTokens(info.tokens)
        const decision = resolveReportNudge(
            contextTokens,
            state.reportNudgeBucket,
            config.reportNudge.tokenInterval,
        )
        state.reportNudgeBucket = decision.bucket
        if (!decision.due) return

        try {
            const model =
                info.providerID && info.modelID
                    ? { providerID: info.providerID, modelID: info.modelID }
                    : undefined
            const result: any = await promptSessionAsync(client, {
                sessionId: info.sessionID,
                agent: info.agent,
                model,
                variant: state.variant,
                parts: [{ type: "text", text: renderReportNudgePrompt() }],
            })
            const promptError = result?.error ?? result?.data?.info?.error ?? result?.info?.error
            if (promptError) throw new Error(describeError(promptError))

            logger.info("Opened visible handoff report checkpoint", {
                sessionId: info.sessionID,
                messageId: info.id,
                contextTokens,
                bucket: decision.bucket,
            })
        } catch (error: any) {
            logger.error("Could not open the handoff report checkpoint", {
                sessionId: info.sessionID,
                error: error?.message || String(error),
            })
        }
    }
}
