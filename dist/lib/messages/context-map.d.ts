import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
export type ContextMapKey = number | string;
export interface ContextMapEntry {
    key: ContextMapKey;
    position: number;
    kind: "message" | "block";
    role: string;
    rawMessageIds: string[];
    anchorMessageId?: string;
    preview: string;
    tokenEstimate: number;
    toolCallCount: number;
    toolTypes: string[];
    protected?: boolean;
}
export interface ContextMapResult {
    mapText: string;
    lookup: Map<number | string, string[]>;
    entries: ContextMapEntry[];
    keyOrder: Array<number | string>;
    keyToPosition: Map<number | string, number>;
    protectedMessageIds: string[];
}
export interface ContextMapOptions {
    /** Derive and mark the newest N OpenCode execution turns as an unselectable tail. */
    protectedTurns?: number;
    /** Reapply a previously persisted automatic-turn tail to a fresh map snapshot. */
    protectedMessageIds?: string[];
}
export interface ResolvedContextMapRange {
    fromKey: ContextMapKey;
    toKey: ContextMapKey;
    startPosition: number;
    endPosition: number;
    mapEntryCount: number;
    entries: ContextMapEntry[];
    messageIds: string[];
    nonBlockMessageIds: string[];
    blockIds: string[];
}
export declare function buildContextMap(rawMessages: WithParts[], state: SessionState, logger: Logger, providerId?: string, options?: ContextMapOptions): ContextMapResult;
export declare function resolveContextMapRange(contextMap: ContextMapResult, from: number | string, to: number | string): ResolvedContextMapRange;
//# sourceMappingURL=context-map.d.ts.map