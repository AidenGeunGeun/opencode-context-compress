/**
 * Compress help command handler.
 * Shows available compression commands and their descriptions.
 */
import type { Logger } from "../logger.js";
import type { PluginClient } from "../sdk/client.js";
export interface HelpCommandContext {
    client: PluginClient;
    logger: Logger;
    sessionId: string;
}
export declare function handleHelpCommand(ctx: HelpCommandContext): Promise<void>;
//# sourceMappingURL=help.d.ts.map