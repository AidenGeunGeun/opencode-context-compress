import type { SessionState, ToolParameterEntry, WithParts } from "./types.js"
import type { Logger } from "../logger.js"
import { loadSessionState } from "./persistence.js"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
} from "./utils.js"

export interface SessionStateSyncResult {
    source: "memory" | "disk-load" | "disk-reload" | "disk-cleared"
    lastUpdated: string | null
}

export function commitDurableSessionState(state: SessionState, candidate: SessionState): void {
    state.compressed = candidate.compressed
    state.compressSummaries = candidate.compressSummaries
    state.managementTurns = candidate.managementTurns
    state.stats = candidate.stats
    state.autoCompressionEnabledOverride = candidate.autoCompressionEnabledOverride
    state.autoCompressionTokenThresholdOverride =
        candidate.autoCompressionTokenThresholdOverride
    state.autoCompressionContextWindowRatioOverride =
        candidate.autoCompressionContextWindowRatioOverride
    state.compressionCooldownAfterMessageId = candidate.compressionCooldownAfterMessageId
    state.hasPersistedState = candidate.hasPersistedState
    state.persistedLastUpdated = candidate.persistedLastUpdated
}

function applyPersistedState(state: SessionState, persisted: Awaited<ReturnType<typeof loadSessionState>>) {
    if (!persisted || persisted.status !== "loaded") {
        return
    }

    const persistedState = persisted.state

    state.compressed = {
        toolIds: new Set(persistedState.compressed.toolIds || []),
        messageIds: new Set(persistedState.compressed.messageIds || []),
    }
    state.compressSummaries = persistedState.compressSummaries || []
    state.managementTurns = persistedState.managementTurns || []
    state.stats = {
        compressTokenCounter: persistedState.stats?.compressTokenCounter || 0,
        totalCompressTokens: persistedState.stats?.totalCompressTokens || 0,
    }
    state.autoCompressionEnabledOverride = persistedState.autoCompressionEnabledOverride
    state.autoCompressionTokenThresholdOverride =
        persistedState.autoCompressionTokenThresholdOverride
    state.autoCompressionContextWindowRatioOverride =
        persistedState.autoCompressionContextWindowRatioOverride
    state.compressionCooldownAfterMessageId = persistedState.compressionCooldownAfterMessageId
    state.hasPersistedState = true
    state.persistedLastUpdated = persistedState.lastUpdated || null
}

function clearPersistedCompressionState(state: SessionState): void {
    state.compressed = {
        toolIds: new Set<string>(),
        messageIds: new Set<string>(),
    }
    state.compressSummaries = []
    state.managementTurns = []
    state.stats = {
        compressTokenCounter: 0,
        totalCompressTokens: 0,
    }
    state.autoCompressionEnabledOverride = undefined
    state.autoCompressionTokenThresholdOverride = undefined
    state.autoCompressionContextWindowRatioOverride = undefined
    state.compressionCooldownAfterMessageId = undefined
    state.hasPersistedState = false
    state.persistedLastUpdated = null
}

async function refreshPersistedSessionState(
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
): Promise<SessionStateSyncResult> {
    const persisted = await loadSessionState(sessionId, logger, messages)
    if (persisted.status === "missing") {
        state.persistenceSynchronized = true
        if (state.hasPersistedState) {
            clearPersistedCompressionState(state)
            return {
                source: "disk-cleared",
                lastUpdated: null,
            }
        }

        return {
            source: "memory",
            lastUpdated: state.persistedLastUpdated,
        }
    }

    if (persisted.status === "error") {
        state.persistenceSynchronized = false
        return {
            source: "memory",
            lastUpdated: state.persistedLastUpdated,
        }
    }

    state.persistenceSynchronized = true

    if (!state.hasPersistedState) {
        applyPersistedState(state, persisted)
        return {
            source: "disk-load",
            lastUpdated: state.persistedLastUpdated,
        }
    }

    if (state.persistedLastUpdated !== persisted.state.lastUpdated) {
        applyPersistedState(state, persisted)
        return {
            source: "disk-reload",
            lastUpdated: state.persistedLastUpdated,
        }
    }

    return {
        source: "memory",
        lastUpdated: state.persistedLastUpdated,
    }
}

export class SessionStateManager {
    private sessions = new Map<string, SessionState>()
    private mutationTails = new Map<string, Promise<void>>()

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
        this.mutationTails.delete(sessionId)
    }

    size(): number {
        return this.sessions.size
    }

    async runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.mutationTails.get(sessionId) ?? Promise.resolve()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const tail = previous.then(
            () => gate,
            () => gate,
        )
        this.mutationTails.set(sessionId, tail)

        await previous.catch(() => undefined)
        try {
            return await operation()
        } finally {
            release()
            if (this.mutationTails.get(sessionId) === tail) {
                this.mutationTails.delete(sessionId)
            }
        }
    }
}

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): Promise<SessionStateSyncResult> => {
    if (!state.sessionId) {
        return {
            source: "memory",
            lastUpdated: null,
        }
    }

    let syncResult: SessionStateSyncResult = {
        source: "memory",
        lastUpdated: state.persistedLastUpdated,
    }

    try {
        syncResult = await ensureSessionInitialized(client, state, state.sessionId, logger, messages)
    } catch (err: any) {
        logger.error("Failed to initialize session state", { error: err.message })
        return syncResult
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
    return syncResult
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        initialized: false,
        isSubAgent: false,
        persistenceSynchronized: false,
        hasPersistedState: false,
        persistedLastUpdated: null,
        compressed: {
            toolIds: new Set<string>(),
            messageIds: new Set<string>(),
        },
        compressSummaries: [],
        managementTurns: [],
        stats: {
            compressTokenCounter: 0,
            totalCompressTokens: 0,
        },
        autoCompressionEnabledOverride: undefined,
        autoCompressionTokenThresholdOverride: undefined,
        autoCompressionContextWindowRatioOverride: undefined,
        compressionCooldownAfterMessageId: undefined,
        toolParameters: new Map<string, ToolParameterEntry>(),
        toolIdList: [],
        lastCompaction: 0,
        currentTurn: 0,
        variant: undefined,
        autoCompressionStarting: false,
        lastAutoTriggeredMessageId: undefined,
    }
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
): Promise<SessionStateSyncResult> {
    if (state.sessionId && state.sessionId !== sessionId) {
        throw new Error(
            `Session state mismatch: existing=${state.sessionId}, requested=${sessionId}`,
        )
    }

    state.sessionId = sessionId

    if (!state.initialized) {
        const isSubAgent = await isSubAgentSession(client, sessionId)
        state.isSubAgent = isSubAgent

        state.lastCompaction = findLastCompactionTimestamp(messages)
        state.initialized = true
    }

    const syncResult = await refreshPersistedSessionState(state, sessionId, logger, messages)
    state.currentTurn = countTurns(state, messages)
    return syncResult
}
