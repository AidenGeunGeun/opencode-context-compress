import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
export declare const PROTECTED_TOOLS: Set<string>;
/**
 * Background pruning, invisible to the agent: outputs of tool calls older than the newest
 * PROTECTED_STEPS steps since the last fold become a one-line stub, and failed calls lose their
 * string inputs. Marks are durable and only grow, so request bytes stay identical between events
 * and the provider's prompt cache holds.
 *
 * An event prunes every candidate at once, by rent or buy: stale outputs keep being re-read from the
 * cache until those reads reach 1 / REWRITE_TOLERANCE of the cost of the cache rewrite the prune
 * causes. This needs no guess of how long the session will run, and it never prunes on every step.
 * Costs count characters, since the tokenizer ratio cancels out. A cached read costs the model's listed
 * cache read price as a fraction of its input price (0.05 on Opus 5.5 and GPT-6.1), or 0.1 when the host lists
 * none; a cache write costs the input price.
 *
 * A provider can only resume the cache at a marker an earlier request placed. Without one before the
 * first pruned output, the rewrite starts at the end of the system prompt and covers the whole
 * conversation. `anchored` says the request carries a marker just before the prune frontier (see
 * `pruneFrontier`), so the rewrite starts there.
 */
export declare function pruneStaleToolOutputs(messages: WithParts[], state: SessionState, logger: Logger, anchored: boolean): Promise<void>;
/**
 * The oldest tool call a later prune may still change. Everything before it stays byte-identical
 * until the next fold, so a cache marker placed just before its message lets a prune rewrite only
 * what follows.
 */
export declare function pruneFrontier(messages: WithParts[], state: SessionState): string | undefined;
//# sourceMappingURL=prune.d.ts.map