import type { PluginConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { type PluginClient } from "./sdk/client.js";
import type { SessionStateManager } from "./state/index.js";
/**
 * Sends the fold request when a step ends at the threshold, and again at every further REPEAT_TOKENS.
 * A fold or prune that shrinks the context lowers the level, which re-arms the request.
 */
export declare function createFoldRequestHandler(client: PluginClient, stateManager: SessionStateManager, logger: Logger, config: PluginConfig, pending: ReadonlyMap<string, unknown>, acceptsSession: (sessionID: string, event: unknown) => Promise<boolean>): (input: unknown) => Promise<void>;
//# sourceMappingURL=fold-request.d.ts.map