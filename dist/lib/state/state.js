import { loadSessionState, saveSessionState } from "./persistence.js";
import { isSubAgentSession, isCompletedNativeCompaction, findLastCompactionTimestamp, countTurns, resetOnCompaction, } from "./utils.js";
import { findActiveManagementTurn } from "../messages/compress-transform.js";
import { isIgnoredUserMessage } from "../messages/utils.js";
export function commitDurableSessionState(state, candidate) {
    state.compressed = candidate.compressed;
    state.compressSummaries = candidate.compressSummaries;
    state.managementTurns = candidate.managementTurns;
    state.compressionMapSnapshot = candidate.compressionMapSnapshot;
    state.stats = candidate.stats;
    state.autoCompressionEnabledOverride = candidate.autoCompressionEnabledOverride;
    state.autoCompressionTokenThresholdOverride =
        candidate.autoCompressionTokenThresholdOverride;
    state.autoCompressionContextWindowRatioOverride =
        candidate.autoCompressionContextWindowRatioOverride;
    state.compressionCooldownAfterMessageId = candidate.compressionCooldownAfterMessageId;
    state.goalOverflowRecovery = candidate.goalOverflowRecovery;
    state.lastCompaction = candidate.lastCompaction;
    state.hasPersistedState = candidate.hasPersistedState;
    state.persistedLastUpdated = candidate.persistedLastUpdated;
}
function applyPersistedState(state, persisted) {
    if (!persisted || persisted.status !== "loaded") {
        return;
    }
    const persistedState = persisted.state;
    state.compressed = {
        toolIds: new Set(persistedState.compressed.toolIds || []),
        messageIds: new Set(persistedState.compressed.messageIds || []),
    };
    state.compressSummaries = persistedState.compressSummaries || [];
    state.managementTurns = persistedState.managementTurns || [];
    state.compressionMapSnapshot = persistedState.compressionMapSnapshot;
    state.stats = {
        compressTokenCounter: persistedState.stats?.compressTokenCounter || 0,
        totalCompressTokens: persistedState.stats?.totalCompressTokens || 0,
    };
    state.autoCompressionEnabledOverride = persistedState.autoCompressionEnabledOverride;
    state.autoCompressionTokenThresholdOverride =
        persistedState.autoCompressionTokenThresholdOverride;
    state.autoCompressionContextWindowRatioOverride =
        persistedState.autoCompressionContextWindowRatioOverride;
    state.compressionCooldownAfterMessageId = persistedState.compressionCooldownAfterMessageId;
    state.goalOverflowRecovery = persistedState.goalOverflowRecovery;
    state.lastCompaction = persistedState.lastCompaction ?? 0;
    state.hasPersistedState = true;
    state.persistedLastUpdated = persistedState.lastUpdated || null;
}
function clearPersistedCompressionState(state) {
    state.compressed = {
        toolIds: new Set(),
        messageIds: new Set(),
    };
    state.compressSummaries = [];
    state.managementTurns = [];
    state.compressionMapSnapshot = undefined;
    state.stats = {
        compressTokenCounter: 0,
        totalCompressTokens: 0,
    };
    state.autoCompressionEnabledOverride = undefined;
    state.autoCompressionTokenThresholdOverride = undefined;
    state.autoCompressionContextWindowRatioOverride = undefined;
    state.compressionCooldownAfterMessageId = undefined;
    state.goalOverflowRecovery = undefined;
    state.lastCompaction = 0;
    state.hasPersistedState = false;
    state.persistedLastUpdated = null;
}
async function refreshPersistedSessionState(state, sessionId, logger, messages) {
    const persisted = await loadSessionState(sessionId, logger, messages);
    if (persisted.status === "missing") {
        state.persistenceSynchronized = true;
        if (state.hasPersistedState) {
            clearPersistedCompressionState(state);
            return {
                source: "disk-cleared",
                lastUpdated: null,
            };
        }
        return {
            source: "memory",
            lastUpdated: state.persistedLastUpdated,
        };
    }
    if (persisted.status === "error") {
        state.persistenceSynchronized = false;
        return {
            source: "memory",
            lastUpdated: state.persistedLastUpdated,
        };
    }
    state.persistenceSynchronized = true;
    if (!state.hasPersistedState) {
        applyPersistedState(state, persisted);
        return {
            source: "disk-load",
            lastUpdated: state.persistedLastUpdated,
        };
    }
    if (state.persistedLastUpdated !== persisted.state.lastUpdated) {
        applyPersistedState(state, persisted);
        return {
            source: "disk-reload",
            lastUpdated: state.persistedLastUpdated,
        };
    }
    return {
        source: "memory",
        lastUpdated: state.persistedLastUpdated,
    };
}
function findLastCompactionIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (isCompletedNativeCompaction(message)) {
            return index;
        }
    }
    return -1;
}
function getCompressionStateCompactionOrder(state, messages, compactionIndex) {
    const referencedMessageIds = new Set(state.compressed.messageIds);
    for (const summary of state.compressSummaries) {
        referencedMessageIds.add(summary.anchorMessageId);
        for (const messageId of summary.messageIds)
            referencedMessageIds.add(messageId);
    }
    for (const turn of state.managementTurns) {
        referencedMessageIds.add(turn.triggerMessageId);
        if (turn.completedMessageId)
            referencedMessageIds.add(turn.completedMessageId);
    }
    if (state.compressionMapSnapshot) {
        referencedMessageIds.add(state.compressionMapSnapshot.triggerMessageId);
    }
    const hasCompressionState = referencedMessageIds.size > 0 ||
        state.compressed.toolIds.size > 0 ||
        state.compressSummaries.length > 0 ||
        state.managementTurns.length > 0 ||
        state.compressionMapSnapshot !== undefined;
    if (!hasCompressionState)
        return "after";
    if (referencedMessageIds.size === 0)
        return "unknown";
    const indexByMessageId = new Map(messages.map((message, index) => [message.info.id, index]));
    let missingReference = false;
    for (const messageId of referencedMessageIds) {
        const messageIndex = indexByMessageId.get(messageId);
        if (messageIndex === undefined) {
            missingReference = true;
        }
        else if (messageIndex < compactionIndex) {
            return "before";
        }
    }
    return missingReference ? "unknown" : "after";
}
/**
 * Synchronize durable state and reconcile transcript-owned lifecycle authority.
 * The caller must hold the session's SessionStateManager exclusive boundary.
 */
export async function reconcileSessionLifecycle(client, state, sessionId, logger, messages) {
    const syncResult = await ensureSessionInitialized(client, state, sessionId, logger, messages);
    if (!state.persistenceSynchronized)
        return syncResult;
    const compactionTimestamp = findLastCompactionTimestamp(messages);
    const compactionIndex = findLastCompactionIndex(messages);
    const compactionOrder = compactionIndex === -1
        ? "after"
        : getCompressionStateCompactionOrder(state, messages, compactionIndex);
    const unresolvedNewCompaction = compactionTimestamp > state.lastCompaction;
    const requiresCompactionReset = compactionIndex !== -1 &&
        (compactionOrder === "before" ||
            (compactionOrder === "unknown" && unresolvedNewCompaction));
    const snapshot = state.compressionMapSnapshot;
    const activeTurn = snapshot ? findActiveManagementTurn(state, messages) : undefined;
    let latestVisibleUserMessageId;
    if (snapshot?.source === "normal") {
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message.info.role === "user" && !isIgnoredUserMessage(message)) {
                latestVisibleUserMessageId = message.info.id;
                break;
            }
        }
    }
    const snapshotIsStale = snapshot !== undefined &&
        (snapshot.source === "management"
            ? activeTurn?.turn.triggerMessageId !== snapshot.triggerMessageId
            : activeTurn !== undefined || latestVisibleUserMessageId !== snapshot.triggerMessageId);
    if (requiresCompactionReset || unresolvedNewCompaction || snapshotIsStale) {
        const candidate = {
            ...state,
            ...(requiresCompactionReset
                ? {
                    compressed: {
                        toolIds: new Set(),
                        messageIds: new Set(),
                    },
                    compressSummaries: [],
                    managementTurns: [],
                }
                : {}),
            ...(requiresCompactionReset || snapshotIsStale
                ? { compressionMapSnapshot: undefined }
                : {}),
            ...(unresolvedNewCompaction
                ? { lastCompaction: compactionTimestamp }
                : {}),
        };
        const persisted = await saveSessionState(candidate, logger);
        if (!persisted) {
            state.persistenceSynchronized = false;
            return syncResult;
        }
        commitDurableSessionState(state, candidate);
        if (requiresCompactionReset) {
            resetOnCompaction(state);
            logger.info("Reconciled native compaction against durable compression state", {
                timestamp: compactionTimestamp,
            });
        }
    }
    return syncResult;
}
export class SessionStateManager {
    sessions = new Map();
    mutationTails = new Map();
    get(sessionId) {
        let state = this.sessions.get(sessionId);
        if (!state) {
            state = createSessionState();
            state.sessionId = sessionId;
            this.sessions.set(sessionId, state);
        }
        return state;
    }
    has(sessionId) {
        return this.sessions.has(sessionId);
    }
    delete(sessionId) {
        this.sessions.delete(sessionId);
        this.mutationTails.delete(sessionId);
    }
    size() {
        return this.sessions.size;
    }
    async runExclusive(sessionId, operation) {
        const previous = this.mutationTails.get(sessionId) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate, () => gate);
        this.mutationTails.set(sessionId, tail);
        await previous.catch(() => undefined);
        try {
            return await operation();
        }
        finally {
            release();
            if (this.mutationTails.get(sessionId) === tail) {
                this.mutationTails.delete(sessionId);
            }
        }
    }
}
export const checkSession = async (client, state, logger, messages) => {
    if (!state.sessionId) {
        return {
            source: "memory",
            lastUpdated: null,
        };
    }
    let syncResult = {
        source: "memory",
        lastUpdated: state.persistedLastUpdated,
    };
    try {
        syncResult = await reconcileSessionLifecycle(client, state, state.sessionId, logger, messages);
    }
    catch (err) {
        logger.error("Failed to initialize session state", { error: err.message });
        return syncResult;
    }
    state.currentTurn = countTurns(state, messages);
    return syncResult;
};
export function createSessionState() {
    return {
        sessionId: null,
        initialized: false,
        isSubAgent: false,
        persistenceSynchronized: false,
        hasPersistedState: false,
        persistedLastUpdated: null,
        compressed: {
            toolIds: new Set(),
            messageIds: new Set(),
        },
        compressSummaries: [],
        managementTurns: [],
        compressionMapSnapshot: undefined,
        stats: {
            compressTokenCounter: 0,
            totalCompressTokens: 0,
        },
        autoCompressionEnabledOverride: undefined,
        autoCompressionTokenThresholdOverride: undefined,
        autoCompressionContextWindowRatioOverride: undefined,
        compressionCooldownAfterMessageId: undefined,
        goalOverflowRecovery: undefined,
        toolParameters: new Map(),
        toolIdList: [],
        lastCompaction: 0,
        currentTurn: 0,
        variant: undefined,
        autoCompressionStarting: false,
        lastAutoTriggeredMessageId: undefined,
    };
}
export async function ensureSessionInitialized(client, state, sessionId, logger, messages) {
    if (state.sessionId && state.sessionId !== sessionId) {
        throw new Error(`Session state mismatch: existing=${state.sessionId}, requested=${sessionId}`);
    }
    state.sessionId = sessionId;
    if (!state.initialized) {
        const isSubAgent = await isSubAgentSession(client, sessionId);
        state.isSubAgent = isSubAgent;
        state.initialized = true;
    }
    const syncResult = await refreshPersistedSessionState(state, sessionId, logger, messages);
    state.currentTurn = countTurns(state, messages);
    return syncResult;
}
//# sourceMappingURL=state.js.map