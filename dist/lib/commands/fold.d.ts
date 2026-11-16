import type { Logger } from "../logger.js";
import { type PluginClient } from "../sdk/client.js";
import type { SessionState } from "../state/index.js";
import { type SessionStateManager } from "../state/state.js";
/** Turns automatic fold requests on or off for one session, or shows which applies. */
export declare function handleFoldCommand(ctx: {
    client: PluginClient;
    stateManager: SessionStateManager;
    state: SessionState;
    logger: Logger;
    sessionId: string;
    action: string;
}): Promise<void>;
//# sourceMappingURL=fold.d.ts.map