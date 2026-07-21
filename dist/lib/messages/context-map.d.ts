import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
export interface DeterministicCompressionSpan {
    messages: WithParts[];
    messageIds: string[];
    protectedMessageIds: string[];
}
/**
 * Select every uncompressed physical message after the newest durable block, while
 * preserving the configured newest execution steps verbatim.
 */
export declare function selectDeterministicCompressionSpan(rawHistory: WithParts[], state: SessionState, logger: Logger, protectedTurns: number): DeterministicCompressionSpan;
export declare function deriveAutomaticProtectedTail(rawMessages: WithParts[], state: SessionState, logger: Logger, protectedTurns: number): {
    protectedMessageIds: string[];
    hasSelectableMessages: boolean;
};
//# sourceMappingURL=context-map.d.ts.map