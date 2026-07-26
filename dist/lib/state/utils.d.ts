import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "./types.js";
/**
 * Decided once per session and never re-checked, so a lookup failure here silently commits
 * the session to being treated as a main session for its entire life. Reporting it is the
 * only way to tell that apart from a genuine negative.
 */
export declare function isSubAgentSession(client: any, sessionID: string, logger: Logger): Promise<boolean>;
export declare function isCompletedNativeCompaction(message: WithParts): boolean;
export declare function findLastCompactionTimestamp(messages: WithParts[]): number;
export declare function resetOnCompaction(state: SessionState): void;
//# sourceMappingURL=utils.d.ts.map