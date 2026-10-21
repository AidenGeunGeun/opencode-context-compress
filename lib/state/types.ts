export interface MessageBase {
    id: string
    sessionID: string
    role: "user" | "assistant" | "system"
    sourceType?: string
    time: { created: number; completed?: number }
    agent?: string
    variant?: string
    model?: { providerID: string; modelID: string }
    providerID?: string
    modelID?: string
    parentID?: string
    summary?: boolean
    finish?: string
    error?: unknown
    tokens?: {
        input: number
        output: number
        reasoning: number
        cache: { read: number; write: number }
    }
}

export interface TextPart {
    type: "text" | "reasoning"
    text: string
    id?: string
    sessionID?: string
    messageID?: string
    synthetic?: boolean
    ignored?: boolean
}

export interface ToolPart {
    type: "tool"
    callID: string
    tool: string
    executed?: boolean
    state: {
        status: "streaming" | "running" | "completed" | "error"
        input: string | Record<string, unknown>
        output?: unknown
        error?: unknown
    }
}

export interface MarkerPart {
    type: "step-start" | "step-finish" | "compaction" | "file" | "patch" | "snapshot" | "subtask"
    [key: string]: unknown
}

export type Message = MessageBase
export type UserMessage = MessageBase
export type AssistantMessage = MessageBase
export type Part = TextPart | ToolPart | MarkerPart

export interface WithParts {
    info: Message
    parts: Part[]
}

export interface SessionStats {
    compressTokenCounter: number
    totalCompressTokens: number
}

export interface CompressSummary {
    anchorMessageId: string
    messageIds: string[]
    summary: string
    topic?: string
}

export interface ManagementTurn {
    triggerMessageId: string
    /** Prospective cleanup contract. Missing means preserve legacy span cleanup semantics. */
    cleanupVersion?: 2
    retainedText?: string
    /** Present for plugin-initiated automatic turns or explicit squash management. */
    source?: "automatic" | "squash"
    /** Assistant message whose completed usage crossed the automatic threshold. */
    triggeredByMessageId?: string
    /** Raw message IDs that automatic compression must leave visible as the active tail. */
    protectedMessageIds?: string[]
    contextTokens?: number
    thresholdTokens?: number
    /** ISO timestamp set once the owning compression tool completes this turn. */
    completedAt?: string
    /** The assistant message ID that carried the completing compression tool call. */
    completedMessageId?: string
}

export interface Compressed {
    toolIds: Set<string>
    messageIds: Set<string>
}

export interface SessionState {
    sessionId: string | null
    initialized: boolean
    /** Runtime-only: the persisted state was successfully loaded or confirmed absent. */
    persistenceSynchronized: boolean
    hasPersistedState: boolean
    persistedLastUpdated: string | null
    compressed: Compressed
    compressSummaries: CompressSummary[]
    managementTurns: ManagementTurn[]
    /** Legacy persisted field: read from older state files and cleared on the next save. */
    compressionMapSnapshot?: unknown
    stats: SessionStats
    /** Session-local override. Missing inherits the process-level auto setting. */
    autoCompressionEnabledOverride?: boolean
    /** Session-local absolute threshold override in tokens. */
    autoCompressionTokenThresholdOverride?: number
    /** Session-local context-window ratio override in the 0-1 representation. */
    autoCompressionContextWindowRatioOverride?: number
    /** Assistant message carrying the most recent successful `compress` call. */
    compressionCooldownAfterMessageId?: string
    /** Latest native compaction whose compression-state reset was durably reconciled. */
    lastCompaction: number
    /** Runtime-only model metadata resolved from the host model list on each model request. */
    modelContext?: {
        providerId: string
        modelId: string
        contextLimit: number
    }
    /** Runtime-only lock preventing duplicate threshold events from starting two turns. */
    autoCompressionStarting?: boolean
    /** Runtime-only deduplication marker for repeated step ends of the last triggering message. */
    lastAutoTriggeredMessageId?: string
}
