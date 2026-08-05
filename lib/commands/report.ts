import { describeError, type Logger } from "../logger.js"
import type { SessionState, WithParts } from "../state/index.js"
import { renderReportNudgePrompt } from "../prompts/index.js"
import { promptSession, showToast } from "../sdk/client.js"
import { getCurrentParams } from "../token-utils.js"

export interface ReportCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

/**
 * The SDK resolves failures instead of throwing: transport faults surface as a top-level
 * `error`, and a turn the provider rejected surfaces as an `error` on the returned assistant
 * message. Either one means the report was not updated.
 */
function promptError(result: any): string | undefined {
    const error = result?.error ?? result?.data?.info?.error ?? result?.info?.error
    // describeError rather than JSON.stringify: an Error's own properties are non-enumerable,
    // so stringifying one would surface the failure as "{}".
    return error ? describeError(error) : undefined
}

/** Opens the user-requested report checkpoint immediately. */
export async function handleReportCommand(ctx: ReportCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx
    const params = getCurrentParams(state, messages, logger)
    const model =
        params.providerId && params.modelId
            ? { providerID: params.providerId, modelID: params.modelId }
            : undefined

    let failure: string | undefined
    try {
        failure = promptError(
            await promptSession(client, {
                sessionId,
                agent: params.agent,
                model,
                variant: params.variant,
                parts: [{ type: "text", text: renderReportNudgePrompt() }],
            }),
        )
    } catch (error) {
        failure = describeError(error)
    }

    if (failure) {
        logger.error("Handoff report prompt failed", { sessionId, error: failure })
        // Reported over the TUI rather than the chat transport that just failed.
        const notified = await showToast(client, {
            title: "Handoff Report",
            message: `Could not ask the agent to update its report: ${failure}`,
            variant: "error",
            duration: 8000,
        })
        if (!notified) {
            logger.error("Handoff report failure could not be shown to the user", { sessionId })
        }
        return
    }

    logger.info("Handoff report update requested manually", { sessionId })
}
