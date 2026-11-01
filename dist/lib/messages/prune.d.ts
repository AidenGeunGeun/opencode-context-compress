import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
/**
 * Background pruning, invisible to the agent: outputs of tool calls older than the newest
 * PROTECTED_STEPS steps since the last fold become a one-line stub, and failed calls lose their
 * string inputs. Marks are durable and only grow, so request bytes stay identical between events
 * and the provider's prompt cache holds.
 *
 * An event prunes every candidate at once, by rent or buy: stale outputs keep being re-read from the
 * cache until those reads add up to a quarter of the cost of rewriting the cache after them. This
 * needs no guess of how long the session will run, and it never prunes on every step. Costs count
 * characters, since the tokenizer ratio cancels out; a cached read costs 0.1 of an uncached input.
 */
export declare function pruneStaleToolOutputs(messages: WithParts[], state: SessionState, logger: Logger): Promise<void>;
//# sourceMappingURL=prune.d.ts.map