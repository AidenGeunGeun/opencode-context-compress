import { describeError } from "../logger.js";
import { renderReportNudgePrompt } from "../prompts/index.js";
import { promptSession, showToast } from "../sdk/client.js";
import { getCurrentParams } from "../token-utils.js";
/**
 * The SDK resolves failures instead of throwing: transport faults surface as a top-level
 * `error`, and a turn the provider rejected surfaces as an `error` on the returned assistant
 * message. Either one means the report was not updated.
 */
function promptError(result) {
    const error = result?.error ?? result?.data?.info?.error ?? result?.info?.error;
    // describeError rather than JSON.stringify: an Error's own properties are non-enumerable,
    // so stringifying one would surface the failure as "{}".
    return error ? describeError(error) : undefined;
}
/**
 * Manual counterpart to the context-boundary nudge. This one opens its own turn because the
 * user asked for the update now, rather than waiting for a request to ride along with.
 */
export async function handleReportCommand(ctx) {
    const { client, state, logger, sessionId, messages } = ctx;
    const params = getCurrentParams(state, messages, logger);
    const model = params.providerId && params.modelId
        ? { providerID: params.providerId, modelID: params.modelId }
        : undefined;
    // Cleared before the prompt, not after: the transform runs while this turn is in flight and
    // would otherwise append a second copy of the same checkpoint.
    const queuedNudge = state.reportNudgePending === true;
    state.reportNudgePending = false;
    let failure;
    try {
        failure = promptError(await promptSession(client, {
            sessionId,
            agent: params.agent,
            model,
            variant: params.variant,
            parts: [{ type: "text", text: renderReportNudgePrompt() }],
        }));
    }
    catch (error) {
        failure = describeError(error);
    }
    if (failure) {
        // Never clobber a nudge the threshold queued while this prompt was in flight.
        state.reportNudgePending = state.reportNudgePending || queuedNudge;
        logger.error("Handoff report prompt failed", { sessionId, error: failure });
        // Reported over the TUI rather than the chat transport that just failed.
        const notified = await showToast(client, {
            title: "Handoff Report",
            message: `Could not ask the agent to update its report: ${failure}`,
            variant: "error",
            duration: 8000,
        });
        if (!notified) {
            logger.error("Handoff report failure could not be shown to the user", { sessionId });
        }
        return;
    }
    // The turn that just refreshed the report may itself have crossed the interval. That nudge
    // is already satisfied, so consume it rather than reminding again on the next request.
    // Not airtight: the host dispatches completion events fire-and-forget, so an event that
    // lands after this point can still queue one reminder. Excluding it would mean identifying
    // this turn's own assistant message, and the worst case is a single extra reminder the
    // agent may answer with "nothing new" - not worth that machinery.
    state.reportNudgePending = false;
    logger.info("Handoff report update requested manually", { sessionId });
}
//# sourceMappingURL=report.js.map