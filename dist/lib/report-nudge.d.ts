import type { PluginConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { type AssistantMessageInfo } from "./auto-compression.js";
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
export declare function createReportNudgeEventHandler(client: any, stateManager: SessionStateManager, logger: Logger, config: PluginConfig): (input: {
    event?: {
        type?: string;
        properties?: {
            info?: AssistantMessageInfo;
        };
    };
}) => Promise<void>;
//# sourceMappingURL=report-nudge.d.ts.map