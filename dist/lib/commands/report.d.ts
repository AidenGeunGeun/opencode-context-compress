import { type Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
export interface ReportCommandContext {
    client: any;
    state: SessionState;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
}
/**
 * Manual counterpart to the growth-triggered nudge. This one opens its own turn because the
 * user asked for the update now, rather than waiting for a request to ride along with.
 */
export declare function handleReportCommand(ctx: ReportCommandContext): Promise<void>;
//# sourceMappingURL=report.d.ts.map