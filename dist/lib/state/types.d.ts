import { Message, Part } from "@opencode-ai/sdk/v2";
import type { GoalOverflowRecovery } from "../goal.js";
export interface WithParts {
    info: Message;
    parts: Part[];
}
export type ToolStatus = "pending" | "running" | "completed" | "error";
export interface ToolParameterEntry {
    tool: string;
    parameters: any;
    status?: ToolStatus;
    error?: string;
    turn: number;
    tokenCount?: number;
}
export interface SessionStats {
    compressTokenCounter: number;
    totalCompressTokens: number;
}
export interface CompressSummary {
    anchorMessageId: string;
    messageIds: string[];
    summary: string;
    topic?: string;
}
export interface ManagementTurn {
    triggerMessageId: string;
    retainedText?: string;
    /** Present for plugin-initiated automatic turns or explicit squash management. */
    source?: "automatic" | "squash";
    /** Assistant message whose completed usage crossed the automatic threshold. */
    triggeredByMessageId?: string;
    /** Raw message IDs that automatic compression must leave visible as the active tail. */
    protectedMessageIds?: string[];
    contextTokens?: number;
    thresholdTokens?: number;
    /** ISO timestamp set once the owning compression tool completes this turn. */
    completedAt?: string;
    /** The completing compression tool call's ID, if the runtime provided one. */
    completedCallId?: string;
    /** The assistant message ID that carried the completing compression tool call. */
    completedMessageId?: string;
}
export interface Compressed {
    toolIds: Set<string>;
    messageIds: Set<string>;
}
export interface SessionState {
    sessionId: string | null;
    initialized: boolean;
    isSubAgent: boolean;
    /** Runtime-only: the persisted state was successfully loaded or confirmed absent. */
    persistenceSynchronized: boolean;
    hasPersistedState: boolean;
    persistedLastUpdated: string | null;
    compressed: Compressed;
    compressSummaries: CompressSummary[];
    managementTurns: ManagementTurn[];
    /** Ignored legacy field retained only so old in-memory state can be cleared safely. */
    compressionMapSnapshot?: unknown;
    stats: SessionStats;
    /** Session-local override. Missing inherits the process-level auto setting. */
    autoCompressionEnabledOverride?: boolean;
    /** Session-local absolute threshold override in tokens. */
    autoCompressionTokenThresholdOverride?: number;
    /** Session-local context-window ratio override in the 0-1 representation. */
    autoCompressionContextWindowRatioOverride?: number;
    /** Assistant message carrying the most recent successful `compress` call. */
    compressionCooldownAfterMessageId?: string;
    /** Exact blocked Goal version associated with the one overflow recovery attempt. */
    goalOverflowRecovery?: GoalOverflowRecovery;
    toolParameters: Map<string, ToolParameterEntry>;
    toolIdList: string[];
    /** Latest native compaction whose compression-state reset was durably reconciled. */
    lastCompaction: number;
    currentTurn: number;
    variant: string | undefined;
    /** Runtime-only model metadata captured from the latest chat.params hook. */
    modelContext?: {
        providerId: string;
        modelId: string;
        contextLimit: number;
    };
    /** Runtime-only lock preventing duplicate threshold events from starting two turns. */
    autoCompressionStarting?: boolean;
    /** Runtime-only deduplication marker for repeated message.updated events. */
    lastAutoTriggeredMessageId?: string;
}
//# sourceMappingURL=types.d.ts.map