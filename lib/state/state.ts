import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { loadSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
} from "./utils"

export class SessionStateManager {
    private sessions = new Map<string, SessionState>()

    get(sessionId: string): SessionState {
        let state = this.sessions.get(sessionId)
        if (!state) {
            state = createSessionState()
            state.sessionId = sessionId
            this.sessions.set(sessionId, state)
        }
        return state
    }

    has(sessionId: string): boolean {
        return this.sessions.has(sessionId)
    }

    delete(sessionId: string): void {
        this.sessions.delete(sessionId)
    }

    size(): number {
        return this.sessions.size
    }
}

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): Promise<void> => {
    if (!state.sessionId) {
        return
    }

    try {
        await ensureSessionInitialized(client, state, state.sessionId, logger, messages)
    } catch (err: any) {
        logger.error("Failed to initialize session state", { error: err.message })
        return
    }

    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })
    }

    state.currentTurn = countTurns(state, messages)
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        initialized: false,
        isSubAgent: false,
        compressed: {
            toolIds: new Set<string>(),
            messageIds: new Set<string>(),
        },
        compressSummaries: [],
        stats: {
            compressTokenCounter: 0,
            totalCompressTokens: 0,
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        toolIdList: [],
        lastCompaction: 0,
        currentTurn: 0,
        variant: undefined,
    }
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    if (state.sessionId && state.sessionId !== sessionId) {
        logger.error(`[DIAG:init] SESSION MISMATCH: existing=${state.sessionId}, requested=${sessionId}`)
        throw new Error(
            `Session state mismatch: existing=${state.sessionId}, requested=${sessionId}`,
        )
    }

    state.sessionId = sessionId

    if (state.initialized) {
        logger.info(`[DIAG:init] already initialized for ${sessionId} | compressedMsgIds=${state.compressed.messageIds.size} | summaries=${state.compressSummaries.length}`)
        return
    }

    logger.info(`[DIAG:init] FIRST INIT for ${sessionId} | msgCount=${messages.length}`)

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent
    logger.info(`[DIAG:init] isSubAgent=${isSubAgent} for ${sessionId}`)

    state.lastCompaction = findLastCompactionTimestamp(messages)

    const persisted = await loadSessionState(sessionId, logger, messages)
    if (persisted !== null) {
        state.compressed = {
            toolIds: new Set(persisted.compressed.toolIds || []),
            messageIds: new Set(persisted.compressed.messageIds || []),
        }
        state.compressSummaries = persisted.compressSummaries || []
        state.stats = {
            compressTokenCounter: persisted.stats?.compressTokenCounter || 0,
            totalCompressTokens: persisted.stats?.totalCompressTokens || 0,
        }
        logger.info(`[DIAG:init] loaded from disk | toolIds=${state.compressed.toolIds.size} | msgIds=${state.compressed.messageIds.size} | summaries=${state.compressSummaries.length} | totalTokens=${state.stats.totalCompressTokens}`)
    } else {
        logger.info(`[DIAG:init] NO persisted state found for ${sessionId}`)
    }

    state.currentTurn = countTurns(state, messages)
    state.initialized = true
    logger.info(`[DIAG:init] DONE | turn=${state.currentTurn}`)
}
