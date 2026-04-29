/**
 * State persistence module for Context Compress plugin.
 * Persists compressed tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/compress/{sessionId}.json
 */
import type { SessionState, SessionStats, CompressSummary, WithParts } from "./types";
import type { Logger } from "../logger";
/** Compressed state as stored on disk (arrays for JSON compatibility) */
export interface PersistedCompressed {
    toolIds: string[];
    messageIds: string[];
}
export interface PersistedSessionState {
    sessionName?: string;
    compressed: PersistedCompressed;
    compressSummaries: CompressSummary[];
    stats: SessionStats;
    lastUpdated: string;
}
export type LoadSessionStateResult = {
    status: "missing";
} | {
    status: "loaded";
    state: PersistedSessionState;
} | {
    status: "error";
};
type MaybeBackfilledCompressSummary = Omit<CompressSummary, "messageIds"> & {
    messageIds?: string[];
};
export declare function backfillCompressSummaryMessageIds(summaries: MaybeBackfilledCompressSummary[], messages: WithParts[], compressedMessageIds: Set<string>): CompressSummary[];
export declare function saveSessionState(sessionState: SessionState, logger: Logger, sessionName?: string): Promise<void>;
export declare function loadSessionState(sessionId: string, logger: Logger, messages?: WithParts[]): Promise<LoadSessionStateResult>;
export interface AggregatedStats {
    totalTokens: number;
    totalTools: number;
    totalMessages: number;
    sessionCount: number;
}
export interface ForkSessionStateInput {
    sourceSessionId: string;
    targetSessionId: string;
    messageIdMap: Record<string, string>;
    toolIdsByMessageId: Record<string, string[]>;
    sessionName?: string;
}
export type ForkSessionStateResult = {
    status: "missing";
} | {
    status: "error";
} | {
    status: "skipped";
    reason: "empty-message-map" | "empty-migrated-state";
} | {
    status: "migrated";
    summaries: number;
    compressedMessages: number;
    compressedTools: number;
    droppedSummaries: number;
    droppedMessages: number;
};
export declare function forkSessionState(input: ForkSessionStateInput, logger: Logger): Promise<ForkSessionStateResult>;
export declare function loadAllSessionStats(logger: Logger): Promise<AggregatedStats>;
export {};
//# sourceMappingURL=persistence.d.ts.map