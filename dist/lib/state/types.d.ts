import { Message, Part } from "@opencode-ai/sdk/v2";
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
    /** Present only for plugin-initiated automatic compression turns. */
    source?: "automatic";
    /** Assistant message whose completed usage crossed the automatic threshold. */
    triggeredByMessageId?: string;
    /** Raw message IDs that automatic compression must leave visible as the active tail. */
    protectedMessageIds?: string[];
    contextTokens?: number;
    thresholdTokens?: number;
    /** ISO timestamp set once a `compress` call completes this turn. Presence marks completion. */
    completedAt?: string;
    /** The completing `compress` tool call's ID, if the runtime provided one. */
    completedCallId?: string;
    /** The assistant message ID that carried the completing `compress` tool call. */
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
    hasPersistedState: boolean;
    persistedLastUpdated: string | null;
    compressed: Compressed;
    compressSummaries: CompressSummary[];
    managementTurns: ManagementTurn[];
    stats: SessionStats;
    toolParameters: Map<string, ToolParameterEntry>;
    toolIdList: string[];
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