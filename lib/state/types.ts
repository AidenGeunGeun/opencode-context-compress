import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    turn: number
    tokenCount?: number
}

export interface SessionStats {
    compressTokenCounter: number
    totalCompressTokens: number
}

export interface CompressSummary {
    anchorMessageId: string
    messageIds: string[]
    summary: string
}

export interface Compressed {
    toolIds: Set<string>
    messageIds: Set<string>
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    compressed: Compressed
    compressSummaries: CompressSummary[]
    stats: SessionStats
    toolParameters: Map<string, ToolParameterEntry>
    toolIdList: string[]
    lastCompaction: number
    currentTurn: number
    variant: string | undefined
}
