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
 * Shared visible-turn path for both the manual command and automatic context checkpoints.
 */
export declare function handleReportCommand(ctx: ReportCommandContext): Promise<void>;
//# sourceMappingURL=report.d.ts.map