import type { CompressSummary, SessionState, WithParts } from "./types.js"
import type { Logger } from "../logger.js"
import { loadSessionState, saveSessionState } from "./persistence.js"
import {
    isCompletedNativeCompaction,
    findLastCompactionTimestamp,
    resetOnCompaction,
} from "./utils.js"

export interface SessionStateSyncResult {
    source: "memory" | "disk-load" | "disk-reload" | "disk-cleared"
    lastUpdated: string | null
}

export function commitDurableSessionState(state: SessionState, candidate: SessionState): void {
    state.compressed = candidate.compressed
    state.anthropicStubIds = candidate.anthropicStubIds
    state.compressSummaries = candidate.compressSummaries
    state.managementTurns = candidate.managementTurns
    state.foldOff = candidate.foldOff
    state.tokenThreshold = candidate.tokenThreshold
    state.lastCompaction = candidate.lastCompaction
    state.hasPersistedState = candidate.hasPersistedState
    state.persistedLastUpdated = candidate.persistedLastUpdated
}

function applyPersistedState(
    state: SessionState,
    persisted: Awaited<ReturnType<typeof loadSessionState>>,
) {
    if (persisted?.status !== "loaded") {
        return
    }

    const persistedState = persisted.state

    state.compressed = {
        toolIds: new Set(persistedState.compressed.toolIds || []),
        messageIds: new Set(persistedState.compressed.messageIds || []),
    }
    state.anthropicStubIds =
        persistedState.anthropicStubIds && new Set(persistedState.anthropicStubIds)
    state.compressSummaries = persistedState.compressSummaries || []
    state.managementTurns = persistedState.managementTurns || []
    state.foldOff = persistedState.foldOff
    state.tokenThreshold = persistedState.tokenThreshold
    state.lastCompaction = persistedState.lastCompaction ?? 0
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
    state.lastCompaction = 0
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

function findLastCompactionIndex(messages: WithParts[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (isCompletedNativeCompaction(message)) {
            return index
        }
    }
    return -1
}

type CompressionStateCompactionOrder = "before" | "after" | "unknown"

function getCompressionStateCompactionOrder(
    state: SessionState,
    messages: WithParts[],
    compactionIndex: number,
): CompressionStateCompactionOrder {
    const referencedMessageIds = new Set<string>(state.compressed.messageIds)
    for (const summary of state.compressSummaries) {
        referencedMessageIds.add(summary.anchorMessageId)
        for (const messageId of summary.messageIds) referencedMessageIds.add(messageId)
    }
    for (const turn of state.managementTurns) {
        referencedMessageIds.add(turn.triggerMessageId)
        if (turn.completedMessageId) referencedMessageIds.add(turn.completedMessageId)
    }
    const hasCompressionState =
        referencedMessageIds.size > 0 ||
        state.compressed.toolIds.size > 0 ||
        state.compressSummaries.length > 0 ||
        state.managementTurns.length > 0
    if (!hasCompressionState) return "after"
    if (referencedMessageIds.size === 0) return "unknown"

    const indexByMessageId = new Map(messages.map((message, index) => [message.info.id, index]))
    let missingReference = false
    for (const messageId of referencedMessageIds) {
        const messageIndex = indexByMessageId.get(messageId)
        if (messageIndex === undefined) {
            missingReference = true
        } else if (messageIndex < compactionIndex) {
            return "before"
        }
    }
    return missingReference ? "unknown" : "after"
}

/**
 * Synchronize durable state and reconcile transcript-owned lifecycle authority.
 * The caller must hold the session's SessionStateManager exclusive boundary.
 */
export async function reconcileSessionLifecycle(
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
): Promise<SessionStateSyncResult> {
    const syncResult = await ensureSessionInitialized(state, sessionId, logger, messages)
    if (!state.persistenceSynchronized) return syncResult

    const compactionTimestamp = findLastCompactionTimestamp(messages)
    const compactionIndex = findLastCompactionIndex(messages)
    const compactionOrder =
        compactionIndex === -1
            ? "after"
            : getCompressionStateCompactionOrder(state, messages, compactionIndex)
    const unresolvedNewCompaction = compactionTimestamp > state.lastCompaction
    const requiresCompactionReset =
        compactionIndex !== -1 &&
        (compactionOrder === "before" || (compactionOrder === "unknown" && unresolvedNewCompaction))

    if (requiresCompactionReset || unresolvedNewCompaction) {
        const candidate: SessionState = {
            ...state,
            ...(requiresCompactionReset
                ? {
                      compressed: {
                          toolIds: new Set<string>(),
                          messageIds: new Set<string>(),
                      },
                      compressSummaries: [],
                      managementTurns: [],
                  }
                : {}),
            ...(unresolvedNewCompaction ? { lastCompaction: compactionTimestamp } : {}),
        }
        const persisted = await saveSessionState(candidate, logger)
        if (!persisted) {
            state.persistenceSynchronized = false
            return syncResult
        }
        commitDurableSessionState(state, candidate)
        if (requiresCompactionReset) {
            resetOnCompaction(state)
            logger.info("Reconciled native compaction against durable compression state", {
                timestamp: compactionTimestamp,
            })
        }
    }

    // Committing a rewind deletes the rewound messages. A block that lost any of them summarizes
    // undone work, so drop it and let its surviving messages show raw again.
    const present = new Set(messages.map((message) => message.info.id))
    const stale = state.compressSummaries.filter((summary) => cutByRewind(summary, present))
    if (stale.length === 0) return syncResult

    const dropped = new Set(
        stale.flatMap((summary) => [summary.anchorMessageId, ...summary.messageIds]),
    )
    const droppedTools = new Set(
        messages
            .filter((message) => dropped.has(message.info.id))
            .flatMap((message) =>
                message.parts.flatMap((part) => (part.type === "tool" ? [part.callID] : [])),
            ),
    )
    const candidate: SessionState = {
        ...state,
        compressed: {
            messageIds: new Set([...state.compressed.messageIds].filter((id) => !dropped.has(id))),
            toolIds: new Set([...state.compressed.toolIds].filter((id) => !droppedTools.has(id))),
        },
        anthropicStubIds:
            state.anthropicStubIds &&
            new Set([...state.anthropicStubIds].filter((id) => !droppedTools.has(id))),
        compressSummaries: state.compressSummaries.filter((summary) => !stale.includes(summary)),
    }
    if (!(await saveSessionState(candidate, logger))) {
        state.persistenceSynchronized = false
        return syncResult
    }
    commitDurableSessionState(state, candidate)
    logger.info("Dropped compression blocks for rewound messages", { blocks: stale.length })
    return syncResult
}

/**
 * A rewind deletes a suffix of the transcript, so a block it cut keeps at most a prefix of its
 * messages, and keeps its anchor exactly when that prefix is not empty. Any other gap is left for the
 * transform to reject.
 */
function cutByRewind(summary: CompressSummary, present: Set<string>): boolean {
    const cut = summary.messageIds.findIndex((id) => !present.has(id))
    if (cut < 0) return false
    if (summary.messageIds.slice(cut).some((id) => present.has(id))) return false
    return present.has(summary.anchorMessageId) === cut > 0
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

    const unreconciled: SessionStateSyncResult = {
        source: "memory",
        lastUpdated: state.persistedLastUpdated,
    }

    try {
        return await reconcileSessionLifecycle(state, state.sessionId, logger, messages)
    } catch (err) {
        logger.error("Failed to initialize session state", {
            error: err instanceof Error ? err.message : String(err),
        })
        return unreconciled
    }
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        initialized: false,
        persistenceSynchronized: false,
        hasPersistedState: false,
        persistedLastUpdated: null,
        compressed: {
            toolIds: new Set<string>(),
            messageIds: new Set<string>(),
        },
        compressSummaries: [],
        managementTurns: [],
        lastCompaction: 0,
    }
}

export async function ensureSessionInitialized(
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
    state.initialized = true

    return await refreshPersistedSessionState(state, sessionId, logger, messages)
}
