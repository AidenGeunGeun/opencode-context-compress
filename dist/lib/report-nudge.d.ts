import type { PluginConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { type AssistantMessageInfo } from "./auto-compression.js";
import type { SessionState, WithParts } from "./state/index.js";
import { SessionStateManager } from "./state/index.js";
export interface ReportNudgeDecision {
    due: boolean;
    baselineTokens: number | undefined;
}
/**
 * Growth-based trigger over provider-reported usage, the same signal automatic compression
 * uses. A reading below the baseline means compression (or a native compaction) just shrank the
 * context, so the window restarts from the new floor instead of silently swallowing a full
 * interval. An unusable reading leaves the baseline untouched, so a session that starts without
 * usage numbers still measures its first interval from real growth.
 */
export declare function resolveReportNudge(contextTokens: number, baselineTokens: number | undefined, tokenInterval: number): ReportNudgeDecision;
export declare function createReportNudgeEventHandler(stateManager: SessionStateManager, logger: Logger, config: PluginConfig): (input: {
    event?: {
        type?: string;
        properties?: {
            info?: AssistantMessageInfo;
        };
    };
}) => Promise<void>;
/**
 * Rides along with a request the session was making anyway rather than opening its own turn.
 * Delivered once per crossing: a missed nudge is picked up by the next interval or by the
 * pre-compression check, and re-delivering every step would nag through a whole tool loop.
 */
export declare function injectReportNudge(state: SessionState, logger: Logger, messages: WithParts[]): boolean;
//# sourceMappingURL=report-nudge.d.ts.map