import type { PluginConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionState } from "../state/index.js";
import { type SessionStateManager } from "../state/state.js";
import { type PluginClient } from "../sdk/client.js";
export interface AutoCommandContext {
    client: PluginClient;
    stateManager: SessionStateManager;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    arguments: string[];
}
export declare function handleAutoCommand(ctx: AutoCommandContext): Promise<void>;
//# sourceMappingURL=auto.d.ts.map