import { type Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
export interface ReportCommandContext {
    client: any;
    state: SessionState;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
}
/** Opens the user-requested report checkpoint immediately. */
export declare function handleReportCommand(ctx: ReportCommandContext): Promise<void>;
//# sourceMappingURL=report.d.ts.map