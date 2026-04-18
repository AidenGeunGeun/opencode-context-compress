import type { Logger } from "../logger";
import type { SessionState, WithParts } from "../state";
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
}
export interface ContextMapResult {
    mapText: string;
    lookup: Map<number | string, string[]>;
    entries: ContextMapEntry[];
    keyOrder: Array<number | string>;
    keyToPosition: Map<number | string, number>;
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
export declare function buildContextMap(rawMessages: WithParts[], state: SessionState, logger: Logger, providerId?: string): ContextMapResult;
export declare function resolveContextMapRange(contextMap: ContextMapResult, from: number | string, to: number | string): ResolvedContextMapRange;
//# sourceMappingURL=context-map.d.ts.map