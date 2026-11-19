import type { SessionHttpRequest } from "@opencode/plugin/promise/session";
import type { Logger } from "./logger.js";
/**
 * Anthropic binds each thinking block to the tools, system prompt, and every message before it, and drops that block
 * and all later ones when any of those changed. A primary request should therefore only extend the session's previous
 * one, except at a fold. Every request that does not is logged with the parts around its first change, so a drop can be
 * traced to what changed. A fold is marked, not skipped: the state may record a fold only after its first request.
 */
export declare function createPrefixWatch(logger: Logger, lastCompaction: (sessionID: string) => number): (event: SessionHttpRequest, request: Request) => Promise<void>;
//# sourceMappingURL=prefix-watch.d.ts.map