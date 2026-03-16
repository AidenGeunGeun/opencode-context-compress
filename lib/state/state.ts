import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { loadSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
} from "./utils"
import { getLastUserMessage } from "../shared-utils"

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): Promise<void> => {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        try {
            await ensureSessionInitialized(client, state, lastSessionId, logger, messages)
        } catch (err: any) {
            logger.error("Failed to initialize session state", { error: err.message })
        }
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

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.isSubAgent = false
    state.compressed = {
        toolIds: new Set<string>(),
        messageIds: new Set<string>(),
    }
    state.compressSummaries = []
    state.stats = {
        compressTokenCounter: 0,
        totalCompressTokens: 0,
    }
    state.toolParameters.clear()
    state.toolIdList = []
    state.lastCompaction = 0
    state.currentTurn = 0
    state.variant = undefined
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    logger.info("session ID = " + sessionId)
    logger.info("Initializing session state", { sessionId: sessionId })

    resetSessionState(state)
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent
    logger.info("isSubAgent = " + isSubAgent)

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)

    const persisted = await loadSessionState(sessionId, logger, messages)
    if (persisted === null) {
        return
    }

    state.compressed = {
        toolIds: new Set(persisted.compressed.toolIds || []),
        messageIds: new Set(persisted.compressed.messageIds || []),
    }
    state.compressSummaries = persisted.compressSummaries || []
    state.stats = {
        compressTokenCounter: persisted.stats?.compressTokenCounter || 0,
        totalCompressTokens: persisted.stats?.totalCompressTokens || 0,
    }
}
