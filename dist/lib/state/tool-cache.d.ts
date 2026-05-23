import type { SessionState, WithParts } from "./index.js";
import type { Logger } from "../logger.js";
import { PluginConfig } from "../config.js";
/**
 * Sync tool parameters from OpenCode's session.messages() API.
 */
export declare function syncToolCache(state: SessionState, config: PluginConfig, logger: Logger, messages: WithParts[]): Promise<void>;
/**
 * Trim the tool parameters cache to prevent unbounded memory growth.
 * Uses FIFO eviction - removes oldest entries first.
 */
export declare function trimToolParametersCache(state: SessionState): void;
//# sourceMappingURL=tool-cache.d.ts.map