import type { Logger } from "../logger.js";
import type { PluginClient } from "../sdk/client.js";
/** A summary saved by `compress` and the inbox item of the compaction that will apply it. */
export type PendingFold = {
    summary: string;
    inboxID: string;
};
/**
 * Saves the summary for the session's `compaction` hook and admits a native compaction, which core runs
 * right after the current step.
 */
export declare function compress(client: PluginClient, logger: Logger, pending: Map<string, PendingFold>, sessionID: string, input: string): Promise<string>;
//# sourceMappingURL=compress.d.ts.map