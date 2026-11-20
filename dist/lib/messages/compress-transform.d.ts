import type { SessionState, WithParts } from "../state/index.js";
export declare const applyCompressTransforms: (state: SessionState, messages: WithParts[]) => void;
export interface TransformMessagesForSearchResult {
    transformed: WithParts[];
    syntheticMap: Map<string, SessionState["compressSummaries"][number]>;
}
/**
 * Finds the session's currently open management turn, if any: a turn that is not yet
 * marked completed by a successful `compress` call AND has no later visible user message
 * bounding it. At most one such turn should normally exist - starting a new `/compress
 * manage` (itself a visible user message) or any ordinary reply always bounds the previous
 * one. Picks the most recently triggered candidate defensively in case state is corrupt.
 */
export declare function findActiveManagementTurn(state: SessionState, rawMessages: WithParts[]): {
    turn: SessionState["managementTurns"][number];
    triggerIndex: number;
} | undefined;
export declare const transformMessagesForSearch: (rawMessages: WithParts[], state: SessionState) => TransformMessagesForSearchResult;
//# sourceMappingURL=compress-transform.d.ts.map