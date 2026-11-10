import type { PluginConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { type PluginClient } from "../sdk/client.js";
/** Sends the fold request now, with any text the user typed after `manage` as their guidance. */
export declare function handleManageCommand(ctx: {
    client: PluginClient;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    arguments: string;
}): Promise<void>;
//# sourceMappingURL=manage.d.ts.map