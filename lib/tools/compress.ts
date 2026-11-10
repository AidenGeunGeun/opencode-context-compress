import type { Logger } from "../logger.js"
import type { PluginClient } from "../sdk/client.js"

/** A summary saved by `compress` and the inbox item of the compaction that will apply it. */
export type PendingFold = { summary: string; inboxID: string }

/**
 * Saves the summary for the session's `compaction` hook and admits a native compaction, which core runs
 * right after the current step.
 */
export async function compress(
    client: PluginClient,
    logger: Logger,
    pending: Map<string, PendingFold>,
    sessionID: string,
    input: string,
): Promise<string> {
    const summary = input.trim()
    if (!summary) throw new Error("compress requires a non-empty summary. Nothing was folded.")
    const admitted = await client.session.compact({ sessionID }).catch((error: unknown) => {
        const cause = error instanceof Error ? error.message : String(error)
        logger.error("Fold could not start", { sessionId: sessionID, error: cause })
        throw new Error(`Nothing was folded: the compaction could not start. ${cause}`)
    })
    pending.set(sessionID, { summary, inboxID: admitted.id })
    logger.info("Fold summary saved", { sessionId: sessionID, chars: summary.length })
    return "Summary saved. The fold applies right after this step."
}
