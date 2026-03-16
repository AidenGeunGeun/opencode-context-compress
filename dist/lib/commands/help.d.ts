/**
 * Compress help command handler.
 * Shows available compression commands and their descriptions.
 */
import type { Logger } from "../logger";
import type { SessionState, WithParts } from "../state";
export interface HelpCommandContext {
    client: any;
    state: SessionState;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
}
export declare function handleHelpCommand(ctx: HelpCommandContext): Promise<void>;
//# sourceMappingURL=help.d.ts.map