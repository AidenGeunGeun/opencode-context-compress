import type { Logger } from "../logger.js";
import { type PluginClient } from "../sdk/client.js";
import type { SessionState } from "../state/index.js";
import { type SessionStateManager } from "../state/state.js";
/**
 * Turns background pruning on or off for one session. Off stops new prunes only: outputs already pruned
 * stay pruned, because restoring them would rewrite the prompt cache and grow the context at once.
 */
export declare function handlePruneCommand(ctx: {
    client: PluginClient;
    stateManager: SessionStateManager;
    state: SessionState;
    logger: Logger;
    sessionId: string;
    arguments: string[];
}): Promise<void>;
//# sourceMappingURL=prune.d.ts.map