/**
 * Compress stats command handler.
 * Shows compression statistics for the current session and all-time totals.
 */
import type { Logger } from "../logger.js";
import type { PluginClient } from "../sdk/client.js";
import type { SessionState } from "../state/index.js";
export interface StatsCommandContext {
    client: PluginClient;
    state: SessionState;
    logger: Logger;
    sessionId: string;
}
export declare function handleStatsCommand(ctx: StatsCommandContext): Promise<void>;
//# sourceMappingURL=stats.d.ts.map