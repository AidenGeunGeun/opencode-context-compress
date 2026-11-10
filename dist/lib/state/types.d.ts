export interface MessageBase {
    id: string;
    sessionID: string;
    role: "user" | "assistant" | "system";
    sourceType?: string;
    time: {
        created: number;
        completed?: number;
    };
    agent?: string;
    variant?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    providerID?: string;
    modelID?: string;
    parentID?: string;
    summary?: boolean;
    finish?: string;
    error?: unknown;
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
}
export interface TextPart {
    type: "text" | "reasoning";
    text: string;
    id?: string;
    sessionID?: string;
    messageID?: string;
    synthetic?: boolean;
    ignored?: boolean;
}
export interface ToolPart {
    type: "tool";
    callID: string;
    tool: string;
    executed?: boolean;
    state: {
        status: "streaming" | "running" | "completed" | "error";
        input: string | Record<string, unknown>;
        output?: unknown;
        error?: unknown;
    };
}
export interface MarkerPart {
    type: "step-start" | "step-finish" | "compaction" | "file" | "patch" | "snapshot" | "subtask";
    [key: string]: unknown;
}
export type Message = MessageBase;
export type AssistantMessage = MessageBase;
export type Part = TextPart | ToolPart | MarkerPart;
export interface WithParts {
    info: Message;
    parts: Part[];
}
export interface CompressSummary {
    anchorMessageId: string;
    messageIds: string[];
    summary: string;
    topic?: string;
}
export interface ManagementTurn {
    triggerMessageId: string;
    /** Prospective cleanup contract. Missing means preserve legacy span cleanup semantics. */
    cleanupVersion?: 2;
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
    /** Runtime-only: the persisted state was successfully loaded or confirmed absent. */
    persistenceSynchronized: boolean;
    hasPersistedState: boolean;
    persistedLastUpdated: string | null;
    compressed: Compressed;
    /**
     * Pruned calls that Anthropic requests already show as stubs, fixed at the session's first Anthropic
     * request after pruning moved server-side. Anthropic binds thinking to the history it was produced
     * with, so a call must keep looking the same to Anthropic; later prunes reach it as server-side clearing.
     */
    anthropicStubIds?: Set<string>;
    compressSummaries: CompressSummary[];
    managementTurns: ManagementTurn[];
    /**
     * Set by `/compress prune off`: no new background prunes. Already pruned outputs stay pruned, because
     * restoring them would rewrite the prompt cache and grow the context at once.
     */
    pruneOff?: boolean;
    /** Latest native compaction whose compression-state reset was durably reconciled. */
    lastCompaction: number;
    /** Runtime-only model metadata resolved from the host model list on each model request. */
    modelContext?: {
        providerId: string;
        modelId: string;
        contextLimit: number;
        /** Cached read price as a fraction of the input price, when the host lists prices. */
        cacheReadRatio?: number;
    };
}
//# sourceMappingURL=types.d.ts.map