import { describeError } from "./logger.js";
import { getAssistantContextTokens, } from "./auto-compression.js";
import { renderReportNudgePrompt } from "./prompts/index.js";
import { promptSessionAsync } from "./sdk/client.js";
/**
 * Absolute raw-context trigger over provider-reported usage, the same signal automatic
 * compression uses. Crossing 100k, 200k, and so on advances the bucket and fires once. When
 * compression shrinks the context into a lower bucket, tracking drops with it so those absolute
 * boundaries can fire again as the new context grows. An unusable reading leaves state untouched.
 */
export function resolveReportNudge(contextTokens, previousBucket, tokenInterval) {
    if (!Number.isFinite(tokenInterval) || tokenInterval <= 0) {
        return { due: false, bucket: previousBucket };
    }
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
        return { due: false, bucket: previousBucket };
    }
    const bucket = Math.floor(contextTokens / tokenInterval);
    const due = previousBucket !== undefined && bucket > previousBucket;
    return { due, bucket };
}
export function createReportNudgeEventHandler(client, stateManager, logger, config) {
    return async (input) => {
        if (!config.reportNudge.enabled)
            return;
        if (input.event?.type !== "message.updated")
            return;
        const info = input.event.properties?.info;
        if (!info ||
            info.role !== "assistant" ||
            info.agent !== "orchestrator" ||
            info.summary === true ||
            info.error ||
            !info.time?.completed) {
            return;
        }
        const state = stateManager.get(info.sessionID);
        const contextTokens = getAssistantContextTokens(info.tokens);
        const decision = resolveReportNudge(contextTokens, state.reportNudgeBucket, config.reportNudge.tokenInterval);
        state.reportNudgeBucket = decision.bucket;
        if (!decision.due)
            return;
        try {
            const model = info.providerID && info.modelID
                ? { providerID: info.providerID, modelID: info.modelID }
                : undefined;
            const result = await promptSessionAsync(client, {
                sessionId: info.sessionID,
                agent: info.agent,
                model,
                variant: state.variant,
                parts: [{ type: "text", text: renderReportNudgePrompt() }],
            });
            const promptError = result?.error ?? result?.data?.info?.error ?? result?.info?.error;
            if (promptError)
                throw new Error(describeError(promptError));
            logger.info("Opened visible handoff report checkpoint", {
                sessionId: info.sessionID,
                messageId: info.id,
                contextTokens,
                bucket: decision.bucket,
            });
        }
        catch (error) {
            logger.error("Could not open the handoff report checkpoint", {
                sessionId: info.sessionID,
                error: error?.message || String(error),
            });
        }
    };
}
//# sourceMappingURL=report-nudge.js.map