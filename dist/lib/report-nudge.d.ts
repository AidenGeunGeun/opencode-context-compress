import type { PluginConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { type AssistantMessageInfo } from "./auto-compression.js";
import type { SessionState, WithParts } from "./state/index.js";
import { SessionStateManager } from "./state/index.js";
export interface ReportNudgeDecision {
    due: boolean;
    bucket: number | undefined;
}
/**
 * Absolute raw-context trigger over provider-reported usage, the same signal automatic
 * compression uses. Crossing 100k, 200k, and so on advances the bucket and fires once. When
 * compression shrinks the context into a lower bucket, tracking drops with it so those absolute
 * boundaries can fire again as the new context grows. An unusable reading leaves state untouched.
 */
export declare function resolveReportNudge(contextTokens: number, previousBucket: number | undefined, tokenInterval: number): ReportNudgeDecision;
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