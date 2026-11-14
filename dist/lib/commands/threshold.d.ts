import type { PluginConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { type PluginClient } from "../sdk/client.js";
import type { SessionState } from "../state/index.js";
import { type SessionStateManager } from "../state/state.js";
/** Shows or sets the token limit at which this session gets its first fold request. */
export declare function handleThresholdCommand(ctx: {
    client: PluginClient;
    stateManager: SessionStateManager;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    arguments: string[];
}): Promise<void>;
//# sourceMappingURL=threshold.d.ts.map