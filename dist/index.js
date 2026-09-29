// @bun
// index.ts
import { Plugin } from "@opencode/plugin";

// lib/plugin.ts
import { z } from "zod";

// lib/commands/manage.ts
import { createHash as createHash2 } from "crypto";

// lib/state/persistence.ts
import * as fs from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var STORAGE_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "storage", "plugin", "compress");
var LEGACY_STORAGE_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "storage", "plugin", "dcp");
async function ensureStorageDir() {
  if (!existsSync(STORAGE_DIR)) {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  }
}
async function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let tempFileCreated = false;
  try {
    const handle = await fs.open(tempPath, "w");
    tempFileCreated = true;
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    tempFileCreated = false;
  } finally {
    if (tempFileCreated) {
      await fs.rm(tempPath, { force: true }).catch(() => {
        return;
      });
    }
  }
}
async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return {
      status: "loaded",
      data: JSON.parse(content)
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "error",
      error
    };
  }
}
function getSessionFilePath(sessionId) {
  return join(STORAGE_DIR, `${sessionId}.json`);
}
function getLegacySessionFilePath(sessionId) {
  return join(LEGACY_STORAGE_DIR, `${sessionId}.json`);
}
function remapLegacyState(legacy) {
  return {
    sessionName: legacy.sessionName,
    compressed: {
      toolIds: legacy.prune?.toolIds ?? [],
      messageIds: legacy.prune?.messageIds ?? []
    },
    compressSummaries: legacy.compressSummaries ?? [],
    managementTurns: [],
    stats: {
      compressTokenCounter: legacy.stats?.pruneTokenCounter ?? 0,
      totalCompressTokens: legacy.stats?.totalPruneTokens ?? 0
    },
    lastUpdated: legacy.lastUpdated
  };
}
function normalizeManagementTurns(turns) {
  if (!Array.isArray(turns)) {
    return [];
  }
  const normalized = [];
  const seen = new Set;
  for (const turn of turns) {
    if (!turn || typeof turn.triggerMessageId !== "string" || turn.triggerMessageId.length === 0) {
      continue;
    }
    if (seen.has(turn.triggerMessageId)) {
      continue;
    }
    seen.add(turn.triggerMessageId);
    normalized.push({
      triggerMessageId: turn.triggerMessageId,
      ...turn.cleanupVersion === 2 ? { cleanupVersion: 2 } : {},
      ...typeof turn.retainedText === "string" && turn.retainedText.length > 0 ? { retainedText: turn.retainedText } : {},
      ...typeof turn.completedAt === "string" && turn.completedAt.length > 0 ? { completedAt: turn.completedAt } : {},
      ...typeof turn.completedMessageId === "string" && turn.completedMessageId.length > 0 ? { completedMessageId: turn.completedMessageId } : {},
      ...turn.source === "automatic" || turn.source === "squash" ? { source: turn.source } : {},
      ...typeof turn.triggeredByMessageId === "string" && turn.triggeredByMessageId.length > 0 ? { triggeredByMessageId: turn.triggeredByMessageId } : {},
      ...Array.isArray(turn.protectedMessageIds) ? {
        protectedMessageIds: [
          ...new Set(turn.protectedMessageIds.filter((messageId) => typeof messageId === "string" && messageId.length > 0))
        ]
      } : {},
      ...typeof turn.contextTokens === "number" && Number.isFinite(turn.contextTokens) ? { contextTokens: turn.contextTokens } : {},
      ...typeof turn.thresholdTokens === "number" && Number.isFinite(turn.thresholdTokens) ? { thresholdTokens: turn.thresholdTokens } : {}
    });
  }
  return normalized;
}
function backfillCompressSummaryMessageIds(summaries, messages, compressedMessageIds) {
  return summaries.map((summary) => {
    if (Array.isArray(summary.messageIds) && summary.messageIds.length > 0) {
      return {
        anchorMessageId: summary.anchorMessageId,
        messageIds: [...new Set(summary.messageIds)],
        summary: summary.summary,
        ...summary.topic && { topic: summary.topic }
      };
    }
    const anchorIndex = messages.findIndex((msg) => msg.info.id === summary.anchorMessageId);
    const messageIds = [];
    if (anchorIndex !== -1 && compressedMessageIds.has(summary.anchorMessageId)) {
      for (let i = anchorIndex;i < messages.length; i++) {
        const messageId = messages[i].info.id;
        if (!compressedMessageIds.has(messageId)) {
          break;
        }
        if (!messageIds.includes(messageId)) {
          messageIds.push(messageId);
        }
      }
    }
    if (messageIds.length === 0) {
      messageIds.push(summary.anchorMessageId);
    }
    return {
      anchorMessageId: summary.anchorMessageId,
      messageIds,
      summary: summary.summary,
      ...summary.topic && { topic: summary.topic }
    };
  });
}
async function saveSessionState(sessionState, logger, sessionName) {
  try {
    if (!sessionState.sessionId) {
      return false;
    }
    await ensureStorageDir();
    const lastUpdated = new Date().toISOString();
    const state = {
      sessionName,
      compressed: {
        toolIds: [...sessionState.compressed.toolIds],
        messageIds: [...sessionState.compressed.messageIds]
      },
      compressSummaries: sessionState.compressSummaries,
      managementTurns: sessionState.managementTurns,
      stats: sessionState.stats,
      ...typeof sessionState.autoCompressionEnabledOverride === "boolean" ? { autoCompressionEnabledOverride: sessionState.autoCompressionEnabledOverride } : {},
      ...sessionState.autoCompressionTokenThresholdOverride !== undefined ? {
        autoCompressionTokenThresholdOverride: sessionState.autoCompressionTokenThresholdOverride
      } : {},
      ...sessionState.autoCompressionContextWindowRatioOverride !== undefined ? {
        autoCompressionContextWindowRatioOverride: sessionState.autoCompressionContextWindowRatioOverride
      } : {},
      ...sessionState.compressionCooldownAfterMessageId ? {
        compressionCooldownAfterMessageId: sessionState.compressionCooldownAfterMessageId
      } : {},
      ...sessionState.lastCompaction > 0 ? { lastCompaction: sessionState.lastCompaction } : {},
      lastUpdated
    };
    const filePath = getSessionFilePath(sessionState.sessionId);
    const content = JSON.stringify(state, null, 2);
    await writeFileAtomic(filePath, content);
    sessionState.hasPersistedState = true;
    sessionState.persistedLastUpdated = lastUpdated;
    logger.info("Saved session state to disk", {
      sessionId: sessionState.sessionId,
      totalTokensSaved: state.stats.totalCompressTokens
    });
    return true;
  } catch (error) {
    logger.error("Failed to save session state", {
      sessionId: sessionState.sessionId,
      error: error?.message
    });
    return false;
  }
}
async function loadSessionState(sessionId, logger, messages) {
  const filePath = getSessionFilePath(sessionId);
  const primaryResult = await readJsonFile(filePath);
  let state;
  let migrated = false;
  if (primaryResult.status === "loaded") {
    state = primaryResult.data;
  } else if (primaryResult.status === "error") {
    logger.warn("Failed to load session state", {
      sessionId,
      path: filePath,
      error: primaryResult.error?.message
    });
    return { status: "error" };
  } else {
    const legacyPath = getLegacySessionFilePath(sessionId);
    const legacyResult = await readJsonFile(legacyPath);
    if (legacyResult.status === "missing") {
      return { status: "missing" };
    }
    if (legacyResult.status === "error") {
      logger.warn("Failed to load legacy session state", {
        sessionId,
        path: legacyPath,
        error: legacyResult.error?.message
      });
      return { status: "error" };
    }
    logger.info("Found legacy state file, migrating", { sessionId });
    state = remapLegacyState(legacyResult.data);
    migrated = true;
  }
  if (!state || !state.compressed || !Array.isArray(state.compressed.toolIds) || !state.stats) {
    logger.warn("Invalid session state file, preserving in-memory state", {
      sessionId,
      path: migrated ? getLegacySessionFilePath(sessionId) : filePath
    });
    return { status: "error" };
  }
  if (!Array.isArray(state.compressed.messageIds)) {
    state.compressed.messageIds = [];
  }
  let compressSummaries = [];
  if (Array.isArray(state.compressSummaries)) {
    const validSummaries = state.compressSummaries.filter((s) => s !== null && typeof s === "object" && typeof s.anchorMessageId === "string" && typeof s.summary === "string" && (s.messageIds === undefined || Array.isArray(s.messageIds) && s.messageIds.every((messageId) => typeof messageId === "string")));
    if (validSummaries.length !== state.compressSummaries.length) {
      logger.warn("Filtered out malformed compressSummaries entries", {
        sessionId,
        original: state.compressSummaries.length,
        valid: validSummaries.length
      });
    }
    if (messages) {
      compressSummaries = backfillCompressSummaryMessageIds(validSummaries, messages, new Set(state.compressed.messageIds));
    } else {
      compressSummaries = validSummaries.map((summary) => ({
        anchorMessageId: summary.anchorMessageId,
        messageIds: Array.isArray(summary.messageIds) && summary.messageIds.length > 0 ? [...new Set(summary.messageIds)] : [summary.anchorMessageId],
        summary: summary.summary,
        ...summary.topic && { topic: summary.topic }
      }));
    }
  }
  logger.info("Loaded session state from disk", {
    sessionId,
    migrated
  });
  const managementTurns = normalizeManagementTurns(state.managementTurns);
  const result = {
    sessionName: state.sessionName,
    compressed: state.compressed,
    compressSummaries,
    managementTurns,
    stats: state.stats,
    ...typeof state.autoCompressionEnabledOverride === "boolean" ? { autoCompressionEnabledOverride: state.autoCompressionEnabledOverride } : {},
    ...typeof state.autoCompressionTokenThresholdOverride === "number" && Number.isSafeInteger(state.autoCompressionTokenThresholdOverride) && state.autoCompressionTokenThresholdOverride > 0 ? {
      autoCompressionTokenThresholdOverride: state.autoCompressionTokenThresholdOverride
    } : {},
    ...typeof state.autoCompressionContextWindowRatioOverride === "number" && Number.isFinite(state.autoCompressionContextWindowRatioOverride) && state.autoCompressionContextWindowRatioOverride > 0 && state.autoCompressionContextWindowRatioOverride < 1 ? {
      autoCompressionContextWindowRatioOverride: state.autoCompressionContextWindowRatioOverride
    } : {},
    ...typeof state.compressionCooldownAfterMessageId === "string" && state.compressionCooldownAfterMessageId.length > 0 ? {
      compressionCooldownAfterMessageId: state.compressionCooldownAfterMessageId
    } : {},
    ...typeof state.lastCompaction === "number" && Number.isFinite(state.lastCompaction) && state.lastCompaction > 0 ? { lastCompaction: state.lastCompaction } : {},
    lastUpdated: state.lastUpdated
  };
  if (migrated) {
    try {
      await ensureStorageDir();
      const newFilePath = getSessionFilePath(sessionId);
      await writeFileAtomic(newFilePath, JSON.stringify(result, null, 2));
      logger.info("Migrated legacy state to compress path", { sessionId });
    } catch (saveError) {
      logger.warn("Failed to save migrated state (will retry next load)", {
        sessionId,
        error: saveError?.message
      });
    }
  }
  return {
    status: "loaded",
    state: result
  };
}
async function loadAllSessionStats(logger) {
  const result = {
    totalTokens: 0,
    totalTools: 0,
    totalMessages: 0,
    sessionCount: 0
  };
  try {
    if (!existsSync(STORAGE_DIR)) {
      return result;
    }
    const files = await fs.readdir(STORAGE_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    for (const file of jsonFiles) {
      try {
        const filePath = join(STORAGE_DIR, file);
        const content = await fs.readFile(filePath, "utf-8");
        const state = JSON.parse(content);
        if (state?.stats?.totalCompressTokens && state?.compressed?.toolIds) {
          result.totalTokens += state.stats.totalCompressTokens;
          result.totalTools += state.compressed.toolIds.length;
          result.totalMessages += state.compressed.messageIds?.length || 0;
          result.sessionCount++;
        }
      } catch {}
    }
    logger.debug("Loaded all-time stats", result);
  } catch (error) {
    logger.warn("Failed to load all-time stats", { error: error?.message });
  }
  return result;
}

// lib/state/utils.ts
function isCompletedNativeCompaction(message) {
  const info = message.info;
  return info.role === "assistant" && info.summary === true && !!info.finish && !info.error;
}
function findLastCompactionTimestamp(messages) {
  for (let i = messages.length - 1;i >= 0; i--) {
    const msg = messages[i];
    if (isCompletedNativeCompaction(msg)) {
      return msg.info.time.created;
    }
  }
  return 0;
}
function resetOnCompaction(state) {
  state.compressed.toolIds = new Set;
  state.compressed.messageIds = new Set;
  state.compressSummaries = [];
  state.managementTurns = [];
  state.compressionMapSnapshot = undefined;
  state.autoCompressionStarting = false;
  state.lastAutoTriggeredMessageId = undefined;
}

// lib/state/state.ts
function commitDurableSessionState(state, candidate) {
  state.compressed = candidate.compressed;
  state.compressSummaries = candidate.compressSummaries;
  state.managementTurns = candidate.managementTurns;
  state.compressionMapSnapshot = candidate.compressionMapSnapshot;
  state.stats = candidate.stats;
  state.autoCompressionEnabledOverride = candidate.autoCompressionEnabledOverride;
  state.autoCompressionTokenThresholdOverride = candidate.autoCompressionTokenThresholdOverride;
  state.autoCompressionContextWindowRatioOverride = candidate.autoCompressionContextWindowRatioOverride;
  state.compressionCooldownAfterMessageId = candidate.compressionCooldownAfterMessageId;
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
    messageIds: new Set(persistedState.compressed.messageIds || [])
  };
  state.compressSummaries = persistedState.compressSummaries || [];
  state.managementTurns = persistedState.managementTurns || [];
  state.compressionMapSnapshot = undefined;
  state.stats = {
    compressTokenCounter: persistedState.stats?.compressTokenCounter || 0,
    totalCompressTokens: persistedState.stats?.totalCompressTokens || 0
  };
  state.autoCompressionEnabledOverride = persistedState.autoCompressionEnabledOverride;
  state.autoCompressionTokenThresholdOverride = persistedState.autoCompressionTokenThresholdOverride;
  state.autoCompressionContextWindowRatioOverride = persistedState.autoCompressionContextWindowRatioOverride;
  state.compressionCooldownAfterMessageId = persistedState.compressionCooldownAfterMessageId;
  state.lastCompaction = persistedState.lastCompaction ?? 0;
  state.hasPersistedState = true;
  state.persistedLastUpdated = persistedState.lastUpdated || null;
}
function clearPersistedCompressionState(state) {
  state.compressed = {
    toolIds: new Set,
    messageIds: new Set
  };
  state.compressSummaries = [];
  state.managementTurns = [];
  state.compressionMapSnapshot = undefined;
  state.stats = {
    compressTokenCounter: 0,
    totalCompressTokens: 0
  };
  state.autoCompressionEnabledOverride = undefined;
  state.autoCompressionTokenThresholdOverride = undefined;
  state.autoCompressionContextWindowRatioOverride = undefined;
  state.compressionCooldownAfterMessageId = undefined;
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
        lastUpdated: null
      };
    }
    return {
      source: "memory",
      lastUpdated: state.persistedLastUpdated
    };
  }
  if (persisted.status === "error") {
    state.persistenceSynchronized = false;
    return {
      source: "memory",
      lastUpdated: state.persistedLastUpdated
    };
  }
  state.persistenceSynchronized = true;
  if (!state.hasPersistedState) {
    applyPersistedState(state, persisted);
    return {
      source: "disk-load",
      lastUpdated: state.persistedLastUpdated
    };
  }
  if (state.persistedLastUpdated !== persisted.state.lastUpdated) {
    applyPersistedState(state, persisted);
    return {
      source: "disk-reload",
      lastUpdated: state.persistedLastUpdated
    };
  }
  return {
    source: "memory",
    lastUpdated: state.persistedLastUpdated
  };
}
function findLastCompactionIndex(messages) {
  for (let index = messages.length - 1;index >= 0; index--) {
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
  const hasCompressionState = referencedMessageIds.size > 0 || state.compressed.toolIds.size > 0 || state.compressSummaries.length > 0 || state.managementTurns.length > 0;
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
    } else if (messageIndex < compactionIndex) {
      return "before";
    }
  }
  return missingReference ? "unknown" : "after";
}
async function reconcileSessionLifecycle(state, sessionId, logger, messages) {
  const syncResult = await ensureSessionInitialized(state, sessionId, logger, messages);
  if (!state.persistenceSynchronized)
    return syncResult;
  const compactionTimestamp = findLastCompactionTimestamp(messages);
  const compactionIndex = findLastCompactionIndex(messages);
  const compactionOrder = compactionIndex === -1 ? "after" : getCompressionStateCompactionOrder(state, messages, compactionIndex);
  const unresolvedNewCompaction = compactionTimestamp > state.lastCompaction;
  const requiresCompactionReset = compactionIndex !== -1 && (compactionOrder === "before" || compactionOrder === "unknown" && unresolvedNewCompaction);
  const hasLegacyCompressionSnapshot = state.compressionMapSnapshot !== undefined;
  if (requiresCompactionReset || unresolvedNewCompaction || hasLegacyCompressionSnapshot) {
    const candidate = {
      ...state,
      ...requiresCompactionReset ? {
        compressed: {
          toolIds: new Set,
          messageIds: new Set
        },
        compressSummaries: [],
        managementTurns: []
      } : {},
      ...hasLegacyCompressionSnapshot ? { compressionMapSnapshot: undefined } : {},
      ...unresolvedNewCompaction ? { lastCompaction: compactionTimestamp } : {}
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
        timestamp: compactionTimestamp
      });
    }
  }
  return syncResult;
}

class SessionStateManager {
  sessions = new Map;
  mutationTails = new Map;
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
    await previous.catch(() => {
      return;
    });
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(sessionId) === tail) {
        this.mutationTails.delete(sessionId);
      }
    }
  }
}
var checkSession = async (state, logger, messages) => {
  if (!state.sessionId) {
    return {
      source: "memory",
      lastUpdated: null
    };
  }
  const unreconciled = {
    source: "memory",
    lastUpdated: state.persistedLastUpdated
  };
  try {
    return await reconcileSessionLifecycle(state, state.sessionId, logger, messages);
  } catch (err) {
    logger.error("Failed to initialize session state", { error: err.message });
    return unreconciled;
  }
};
function createSessionState() {
  return {
    sessionId: null,
    initialized: false,
    persistenceSynchronized: false,
    hasPersistedState: false,
    persistedLastUpdated: null,
    compressed: {
      toolIds: new Set,
      messageIds: new Set
    },
    compressSummaries: [],
    managementTurns: [],
    compressionMapSnapshot: undefined,
    stats: {
      compressTokenCounter: 0,
      totalCompressTokens: 0
    },
    autoCompressionEnabledOverride: undefined,
    autoCompressionTokenThresholdOverride: undefined,
    autoCompressionContextWindowRatioOverride: undefined,
    compressionCooldownAfterMessageId: undefined,
    lastCompaction: 0,
    variant: undefined,
    currentAgent: undefined,
    autoCompressionStarting: false,
    lastAutoTriggeredMessageId: undefined
  };
}
async function ensureSessionInitialized(state, sessionId, logger, messages) {
  if (state.sessionId && state.sessionId !== sessionId) {
    throw new Error(`Session state mismatch: existing=${state.sessionId}, requested=${sessionId}`);
  }
  state.sessionId = sessionId;
  state.initialized = true;
  return await refreshPersistedSessionState(state, sessionId, logger, messages);
}

// lib/prompts/_codegen/system.generated.ts
var SYSTEM = `<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user ran \`/compress manage\`. Preserve enough context for another agent to pursue the same intended outcome without reinterpreting the user's decisions. Compression is context maintenance, not task completion.

Follow any \`<user-message>\` guidance for this request without sacrificing truthfulness. Unless it asks for compression right away, compression is not urgent: if work is in progress, first bring it to a clean stopping point by finishing and verifying the current step, leaving no edit, command, or line of reasoning half-done, and starting no new large work. A deliberate wrap-up produces a better handoff than a hurried compression.

Then call \`compress\` once, before this turn ends, with \`summary\` and \`topic\`. Selection is automatic: existing blocks are excluded while preserving the newest configured execution steps verbatim.

As part of the wrap-up, update applicable existing durable documentation only for verified facts, settled decisions, or state that actually changed, and only when the task authorizes those edits. Follow the project's documentation conventions; do not create reports, logs, or new continuity documents merely for compression. If documentation is already current or the user requested no edits, skip that work. Read-only agents return candidate findings to the parent; lack of write authority must not block compression.

Summary guidance (use short headings where helpful; omit empty sections):
- User intent: the ultimate outcome and newest active request, including corrections to earlier direction.
- Decisions and boundaries: confirmed requirements, constraints, permissions, and agreed protocols. Separate user decisions from your assumptions, proposals, and unresolved discussion; compression grants no new authority.
- Current state: completed work with its evidence, incomplete work, material failures or uncertainty, and whether a final response was already delivered.
- Continuation: the approach being pursued and the next concrete action, if one exists. Preserve relevant running jobs or subagents and their IDs; check their status rather than launching duplicates.
- References: exact paths, commands, identifiers, and findings needed to continue without repeating investigation.

Keep a compact handoff, not a transcript. Preserve decision-relevant rationale and evidence, not every conversational exchange or raw output. Later evidence supersedes stale plans; never invent facts, approvals, results, or completion. The retained recent execution steps may further update the summary.

A success receipt confirms a durable save and an active fold; do not compress again this turn. Follow the user's requested next step and preserve the actual task disposition: continue authorized active work, but do not reopen completed work, duplicate a final response, or manufacture work while awaiting the user.
A failure means nothing was compressed. Surface the exact diagnostic before deciding whether a retry is warranted.
</system-reminder>
`;

// lib/prompts/_codegen/automatic-system.generated.ts
var AUTOMATIC_SYSTEM = `<system-reminder>
AUTOMATIC CONTEXT COMPRESSION DUE
Working context reached ~{{context_tokens}} tokens; the effective threshold is ~{{threshold_tokens}} tokens ({{threshold_reason}}). Automatic compression has been invoked for this turn. It is due, not urgent: preserve the user's intent and current work so execution can continue across compression; this is not a task-status transition.

First bring the work in progress to a clean stopping point: finish and verify the current step, and leave no edit, command, or line of reasoning half-done. Do not start new large work. A deliberate wrap-up produces a better handoff than a hurried compression.

Then call \`compress\` once, before this turn ends, with a faithful \`summary\` and short \`topic\`. Selection is automatic: existing blocks are excluded and the newest configured execution steps remain verbatim.

As part of the wrap-up, update applicable existing durable documentation only for verified facts, settled decisions, or state that actually changed, and only when the task authorizes those edits. Follow the project's documentation conventions; do not create reports, logs, or new continuity documents merely for compression. If documentation is already current or the user requested no edits, skip that work. Read-only agents return candidate findings to the parent; lack of write authority must not block compression.

Summary guidance (use short headings where helpful; omit empty sections):
- User intent: the ultimate outcome and newest active request, including corrections to earlier direction.
- Decisions and boundaries: confirmed requirements, constraints, permissions, and agreed protocols. Separate user decisions from your assumptions, proposals, and unresolved discussion; compression grants no new authority.
- Current state: completed work with its evidence, incomplete work, material failures or uncertainty, and whether a final response was already delivered.
- Continuation: the approach being pursued and the next concrete action, if one exists. Preserve relevant running jobs or subagents and their IDs; check their status rather than launching duplicates.
- References: exact paths, commands, identifiers, and findings needed to continue without repeating investigation.

Keep a compact handoff, not a transcript. Preserve decision-relevant rationale and evidence, not every conversational exchange or raw output. Later evidence supersedes stale plans; never invent facts, approvals, results, or completion. The retained recent execution steps may further update the summary.

A success receipt confirms a durable save and an active fold. Make no more compression calls this turn. Continue immediately only when work was genuinely active, within the agreed scope and existing authority; do not pause merely to report that compression finished. Preserve completed or awaiting-user status instead of reopening work or duplicating a final response.
A failure means nothing was compressed. Surface the exact diagnostic and do not retry automatically.
</system-reminder>
`;

// lib/prompts/_codegen/compress.generated.ts
var COMPRESS = `DO NOT CALL THIS TOOL UNLESS THE USER EXPLICITLY REQUESTED CONTEXT COMPRESSION IN THE CURRENT TURN OR AUTOMATIC COMPRESSION HAS BEEN INVOKED FOR THIS TURN. High context usage, tool availability, or your own judgment alone is not authorization.

Call once with:
- \`summary\`: A compact, structured handoff preserving the ultimate user intent and newest request; confirmed decisions and permissions separately from assumptions or unresolved proposals; completed work and evidence; current approach, real remaining work, and next action; and necessary paths, identifiers, and running-job references. Omit empty sections and transcript-like detail. Later evidence supersedes stale plans; preserve material uncertainty and never invent facts or completion.
- \`topic\`: A short title for the new compressed block.

Update existing durable documentation only for changed, verified information when authorized; skip edits when already current or the user requested no changes. Read-only agents return findings to the parent instead. Documentation work is not the compression itself, and missing write authority does not block compression.

Existing blocks are excluded; recent execution steps remain verbatim and may supersede the summary. A success receipt confirms a durable save and an active fold; do not compress again that turn. Continue authorized active work according to the latest user guidance, without reopening completed work or duplicating a final response. Automatic compression is not a reason to stop for review.

A failure means nothing changed. Surface the exact diagnostic; do not retry automatically after an automatic compression failure.
`;

// lib/prompts/_codegen/squash-system.generated.ts
var SQUASH_SYSTEM = `<system-reminder>
CONTEXT SQUASH REQUESTED
This turn exists only because the user explicitly ran \`/compress squash\`. Review the current positional compressed blocks and make exactly one successful \`squash\` call.

If a \`<user-message>\` block is present, it contains the user's specific instructions for this squash turn. Follow it while preserving truthfulness and chronology.

Selection:
- \`[bN]\` values are current positional labels, not stable durable identities.
- Choose exactly one contiguous inclusive range containing at least two existing compressed blocks. Choose both endpoints unless \`<user-message>\` gives more specific guidance.
- Prefer a materially verbose or redundant range. Leave independently valuable older or newer blocks intact; do not maximize the range merely because it is selectable.
- Squash touches only the selected existing compressed blocks. All uncompressed conversation and all out-of-range blocks remain unchanged.
- The replacement is inserted at the selected range's first position. Later blocks keep their relative order and receive new positional labels.

Summary fidelity:
- This is additional lossy compression of summaries. The hidden original messages are unavailable and cannot be restored or reread.
- Compress only the selected historical trajectory, not the whole current state. Preserve the selected blocks' internal chronology, objectives, decisions, constraints, established outcomes, unresolved state at the end of that historical range, and load-bearing evidence that remains necessary.
- Never reorder events, blend noncontiguous periods, or import later out-of-range events into the historical replacement as though they occurred inside the selected range.
- You may consult newer out-of-range evidence only to avoid a plainly misleading condensation. Leave that newer evidence represented in its own later block or conversation rather than moving it backward.

Call \`squash\` once with \`from\`, \`to\`, \`summary\`, and \`topic\`.

Result handling:
- A success receipt means the replacement is durable and already active. Do not make a second squash or compress call this turn.
- A failure means nothing changed. Surface the exact diagnostic before deciding whether a retry is warranted.
</system-reminder>
`;

// lib/prompts/_codegen/squash.generated.ts
var SQUASH = `DO NOT CALL THIS TOOL UNLESS THE USER EXPLICITLY REQUESTED BLOCK SQUASHING IN THE CURRENT TURN. High context usage, tool availability, or your own judgment alone is not authorization. Runtime does not persist an authorization marker; this is a strict agent contract.

When requested, call it once with four required non-empty values:
- \`from\`: The inclusive first current positional block label, such as \`b1\`.
- \`to\`: The inclusive last current positional block label, such as \`b12\`.
- \`summary\`: A truthful replacement for only that selected block range.
- \`topic\`: A short replacement block title.

Choose exactly one contiguous inclusive range containing at least two existing compressed blocks. Both endpoints are yours to choose unless the user's \`<user-message>\` gives more specific guidance. \`[bN]\` labels are current positions, not stable durable identities.

Squash touches only existing compressed blocks. All uncompressed conversation and out-of-range blocks remain unchanged. The replacement occupies the selected range's first position; later blocks preserve their relative order and receive new positional labels.

This is additional lossy compression of summaries: the hidden original messages are unavailable. Compress only the selected historical trajectory, not the whole current state. Preserve chronology, objectives, decisions, constraints, established outcomes, the unresolved state at the selected range's end, and necessary evidence. Never reorder events, combine noncontiguous periods, or move later out-of-range evidence backward. Prefer a materially verbose or redundant range while leaving independently valuable blocks intact.

A success receipt means the replacement is durable and already active. Do not call squash or compress again that turn. A failure means nothing changed; surface the exact diagnostic before deciding whether a retry is warranted.
`;

// lib/prompts/_codegen/post-compression-notice.generated.ts
var POST_COMPRESSION_NOTICE = `<system-reminder>
CONTEXT WAS COMPRESSED
Earlier detail was replaced by a summary. Use it together with the preserved recent messages; later user guidance and evidence take precedence.

Reload the skills and project instructions required by the active task only when their needed contents are no longer available or may have changed. Do not reread unrelated material or treat the summary as new authority.

Continue the original task if authorized work remains active. Preserve completed or awaiting-user status; do not invent follow-up work, repeat finished actions, or duplicate a final response.
</system-reminder>
`;

// lib/prompts/index.ts
function renderSystemPrompt() {
  return SYSTEM.trim();
}
function renderAutomaticSystemPrompt(vars) {
  let prompt = AUTOMATIC_SYSTEM.trim();
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }
  return prompt;
}
function renderSquashSystemPrompt() {
  return SQUASH_SYSTEM.trim();
}
function renderPostCompressionNotice() {
  return POST_COMPRESSION_NOTICE.trim();
}
var PROMPTS = {
  "compress-tool-spec": COMPRESS,
  "squash-tool-spec": SQUASH
};
function loadPrompt(name, vars) {
  let content = PROMPTS[name];
  if (!content) {
    throw new Error(`Prompt not found: ${name}`);
  }
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
  }
  return content;
}

// lib/messages/utils.ts
import { ulid } from "ulid";
import { createHash } from "crypto";
var COMPRESS_SUMMARY_PREFIX = `[Compressed conversation block]

`;
var generateUniqueId = (prefix) => `${prefix}_${ulid()}`;
var generateStableId = (prefix, seed) => `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
var createSyntheticUserMessage = (baseMessage, content, variant, stableSeed) => {
  const userInfo = baseMessage.info;
  const now = stableSeed ? userInfo.time.created : Date.now();
  const messageId = stableSeed ? generateStableId("msg", stableSeed) : generateUniqueId("msg");
  const partId = stableSeed ? generateStableId("prt", stableSeed) : generateUniqueId("prt");
  return {
    info: {
      id: messageId,
      sessionID: userInfo.sessionID,
      role: "user",
      agent: userInfo.agent,
      model: userInfo.model,
      time: { created: now },
      ...variant !== undefined && { variant }
    },
    parts: [
      {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: messageId,
        type: "text",
        text: content
      }
    ]
  };
};
var isIgnoredUserMessage = (message) => {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.length === 0) {
    return true;
  }
  for (const part of parts) {
    if (!part.ignored) {
      return false;
    }
  }
  return true;
};

// lib/shared-utils.ts
var isMessageCompacted = (state, msg) => {
  if (msg.info.time.created < state.lastCompaction) {
    return true;
  }
  if (state.compressed.messageIds.has(msg.info.id)) {
    return true;
  }
  return false;
};
var getLastUserMessage = (messages, startIndex) => {
  const start = startIndex ?? messages.length - 1;
  for (let i = start;i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
      return msg;
    }
  }
  return null;
};

// lib/token-utils.ts
import { countTokens as anthropicCountTokens } from "@anthropic-ai/tokenizer";
import { encodingForModel } from "js-tiktoken";
var _tiktokenEncoder = null;
function getTiktokenEncoder() {
  if (!_tiktokenEncoder) {
    _tiktokenEncoder = encodingForModel("gpt-4o");
  }
  return _tiktokenEncoder;
}
function isAnthropicProvider(providerId) {
  if (!providerId)
    return false;
  return providerId.toLowerCase().includes("anthropic");
}
function getCurrentParams(state, messages, logger) {
  const userMsg = getLastUserMessage(messages);
  if (!userMsg) {
    logger.debug("No user message found when determining current params");
    return {
      providerId: state.modelContext?.providerId,
      modelId: state.modelContext?.modelId,
      agent: state.currentAgent,
      variant: state.variant
    };
  }
  const userInfo = userMsg.info;
  const agent = userInfo.agent ?? state.currentAgent;
  const providerId = userInfo.model?.providerID ?? state.modelContext?.providerId;
  const modelId = userInfo.model?.modelID ?? state.modelContext?.modelId;
  const variant = state.variant ?? userInfo.variant;
  return { providerId, modelId, agent, variant };
}
function countTokens(text, providerId) {
  if (!text)
    return 0;
  try {
    if (isAnthropicProvider(providerId)) {
      return anthropicCountTokens(text);
    }
    return getTiktokenEncoder().encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
function estimateTokensBatch(texts, providerId) {
  if (texts.length === 0)
    return 0;
  return countTokens(texts.join(" "), providerId);
}

// lib/ui/utils.ts
function formatStatsHeader(totalTokensSaved, compressTokenCounter) {
  const totalTokensSavedStr = `~${formatTokenCount(totalTokensSaved + compressTokenCounter)}`;
  return [`\u25A3 Context Compress | ${totalTokensSavedStr} saved total`].join(`
`);
}
function formatTokenCount(tokens) {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + " tokens";
  }
  return tokens.toString() + " tokens";
}
function formatProgressBar(total, start, end, width = 20) {
  if (total <= 0)
    return `\u2502${" ".repeat(width)}\u2502`;
  const startIdx = Math.floor(start / total * width);
  const endIdx = Math.min(width - 1, Math.floor(end / total * width));
  let bar = "";
  for (let i = 0;i < width; i++) {
    if (i >= startIdx && i <= endIdx) {
      bar += "\u2591";
    } else {
      bar += "\u2588";
    }
  }
  return `\u2502${bar}\u2502`;
}

// lib/messages/v2-adapter.ts
function adaptProjectedMessages(sessionID, values, selection) {
  const seen = new Set;
  let parentID;
  return values.filter((value) => !isRecord(value) || value.type !== "idle").map((value) => {
    const message = requireRecord(value, "session message");
    const id = requireString(message.id, "session message id");
    if (seen.has(id))
      throw new Error(`Duplicate projected session message ID: ${id}`);
    seen.add(id);
    const type = requireString(message.type, `session message ${id} type`);
    const time = requireRecord(message.time, `session message ${id} time`);
    const created = requireNumber(time.created, `session message ${id} created time`);
    if (type === "user") {
      parentID = id;
      return user(sessionID, id, created, message, selection);
    }
    if (type === "synthetic")
      return synthetic(sessionID, id, created, message, selection);
    if (type === "assistant")
      return assistant(sessionID, id, created, message, time, parentID);
    if (type === "compaction")
      return compaction(sessionID, id, created, message);
    if (type === "system" || type === "skill") {
      return system(sessionID, id, created, type, typeof message.text === "string" ? message.text : "");
    }
    if (type === "shell") {
      const output = isRecord(message.output) && typeof message.output.output === "string" ? message.output.output : "";
      const entry = system(sessionID, id, created, type, `The following shell command was executed by the user:

Command:
${String(message.command ?? "")}

Output:
${output}`);
      entry.info.finish = message.status === "running" ? undefined : "stop";
      return entry;
    }
    if (type === "location-switched") {
      const location = isRecord(message.location) ? message.location.directory : undefined;
      return system(sessionID, id, created, type, typeof location === "string" ? `The working directory has been changed to ${location}.` : "");
    }
    if (type === "agent-switched" || type === "model-switched")
      return system(sessionID, id, created, type, "");
    throw new Error(`Unsupported projected session message type: ${type}`);
  });
}
function user(sessionID, id, created, message, selection) {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      sourceType: "user",
      agent: selection?.agent,
      model: selection?.model ? { providerID: selection.model.providerID, modelID: selection.model.id } : undefined,
      variant: selection?.model?.variant,
      time: { created }
    },
    parts: typeof message.text === "string" && message.text.length > 0 ? [{ type: "text", text: message.text }] : []
  };
}
function synthetic(sessionID, id, created, message, selection) {
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  return {
    info: {
      id,
      sessionID,
      role: "user",
      sourceType: "synthetic",
      agent: selection?.agent,
      model: selection?.model ? { providerID: selection.model.providerID, modelID: selection.model.id } : undefined,
      variant: selection?.model?.variant,
      time: { created }
    },
    parts: [
      {
        type: "text",
        text: typeof message.text === "string" ? message.text : "",
        synthetic: true,
        ...metadata["opencode.context-compress.ignored"] === true ? { ignored: true } : {}
      }
    ]
  };
}
function assistant(sessionID, id, created, message, time, parentID) {
  const model = requireRecord(message.model, `assistant message ${id} model`);
  const providerID = requireString(model.providerID, `assistant message ${id} provider`);
  const modelID = requireString(model.id, `assistant message ${id} model id`);
  const completed = typeof time.completed === "number" ? time.completed : undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      sourceType: "assistant",
      ...parentID ? { parentID } : {},
      time: { created, ...completed === undefined ? {} : { completed } },
      agent: typeof message.agent === "string" ? message.agent : undefined,
      providerID,
      modelID,
      model: { providerID, modelID },
      finish: typeof message.finish === "string" ? message.finish : undefined,
      error: message.error,
      tokens: adaptTokens(message.tokens)
    },
    parts: [{ type: "step-start" }, ...content.map((part) => adaptAssistantPart(id, part))]
  };
}
function adaptAssistantPart(messageID, value) {
  const part = requireRecord(value, `assistant message ${messageID} content`);
  const type = requireString(part.type, `assistant message ${messageID} content type`);
  if (type === "text" || type === "reasoning") {
    return { type, text: typeof part.text === "string" ? part.text : "" };
  }
  if (type !== "tool")
    throw new Error(`Unsupported assistant content type: ${type}`);
  const state = requireRecord(part.state, `assistant tool ${String(part.id)} state`);
  const status = requireToolStatus(state.status);
  const input = status === "streaming" ? String(state.input ?? "") : isRecord(state.input) ? state.input : {};
  return {
    type: "tool",
    callID: requireString(part.id, "assistant tool id"),
    tool: requireString(part.name, "assistant tool name"),
    executed: part.executed === true,
    state: {
      status,
      input,
      ...status === "completed" ? { output: toolOutput(state.content) } : {},
      ...status === "error" ? { error: state.error } : {}
    }
  };
}
function compaction(sessionID, id, created, message) {
  const status = requireString(message.status, `compaction message ${id} status`);
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      sourceType: "compaction",
      summary: true,
      finish: status === "completed" ? "stop" : undefined,
      error: status === "failed" ? message.error : undefined,
      time: { created, ...status === "completed" ? { completed: created } : {} }
    },
    parts: [{ type: "compaction", summary: typeof message.summary === "string" ? message.summary : undefined }]
  };
}
function system(sessionID, id, created, sourceType, text) {
  return {
    info: { id, sessionID, role: "system", sourceType, time: { created } },
    parts: text ? [{ type: "text", text }] : []
  };
}
function adaptTokens(value) {
  if (!isRecord(value))
    return;
  const cache = isRecord(value.cache) ? value.cache : {};
  return {
    input: numberOrZero(value.input),
    output: numberOrZero(value.output),
    reasoning: numberOrZero(value.reasoning),
    cache: { read: numberOrZero(cache.read), write: numberOrZero(cache.write) }
  };
}
function toolOutput(value) {
  if (!Array.isArray(value))
    return value;
  if (value.length === 1 && isRecord(value[0]) && value[0].type === "text" && typeof value[0].text === "string") {
    return value[0].text;
  }
  return value;
}
function requireToolStatus(value) {
  if (value === "streaming" || value === "running" || value === "completed" || value === "error")
    return value;
  throw new Error(`Unsupported assistant tool state: ${String(value)}`);
}
function requireRecord(value, label) {
  if (!isRecord(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Invalid ${label}`);
  return value;
}
function requireNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// lib/sdk/client.ts
function pluginClient(session) {
  return { kind: "promise-plugin", selections: new Map, session };
}
function setSessionSelection(client, sessionID, selection) {
  client.selections.set(sessionID, selection);
}
async function listSessionMessages(client, sessionId) {
  const values = await client.session.context({ sessionID: sessionId });
  if (values.every((value) => typeof value === "object" && value !== null && ("info" in value) && ("parts" in value)))
    return values;
  return adaptProjectedMessages(sessionId, values, client.selections.get(sessionId));
}
async function promptSession(client, input) {
  const text = input.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join(`

`);
  if (!text)
    throw new Error("Session prompt requires text");
  if (input.noReply) {
    return client.session.synthetic({
      sessionID: input.sessionId,
      text,
      description: text,
      metadata: { "opencode.context-compress.ignored": true },
      resume: false
    });
  }
  return client.session.prompt({
    sessionID: input.sessionId,
    text,
    id: input.messageId,
    ...input.metadata ? { metadata: input.metadata } : {},
    delivery: "steer",
    resume: true
  });
}
async function showToast(..._args) {
  return false;
}

// lib/ui/notification.ts
async function sendSquashNotification(client, logger, config, sessionId, outcome) {
  if (config.notification === "off")
    return;
  const delta = outcome.oldVisibleTokens - outcome.newVisibleTokens;
  const change = delta > 0 ? "reduced" : delta < 0 ? "increased" : "unchanged";
  const message = [
    "\u25A3 Context Squash | Complete",
    `\u2192 Replaced: [${outcome.oldFrom}]-[${outcome.oldTo}] \u2192 [${outcome.newLabel}] (${outcome.selectedBlocks} blocks \u2192 1)`,
    `\u2192 Total blocks: ${outcome.blocksBefore} \u2192 ${outcome.blocksAfter} (${outcome.blocksBefore} - ${outcome.selectedBlocks} + 1)`,
    `\u2192 Selected-block context (estimated): ${formatTokenCount(outcome.oldVisibleTokens)} \u2192 ${formatTokenCount(outcome.newVisibleTokens)}; ${change} by ${formatTokenCount(Math.abs(delta))}`,
    ...config.notification === "detailed" ? [`\u2192 Topic: ${outcome.topic}`] : []
  ].join(`
`);
  if (config.notificationType === "toast") {
    const shown = await showToast(client, {
      title: "Squash Notification",
      message,
      variant: "info",
      duration: 5000
    });
    if (shown)
      return;
  }
  await sendIgnoredMessage(client, sessionId, message, {}, logger);
}
var TOAST_BODY_MAX_LINES = 12;
var TOAST_SUMMARY_MAX_CHARS = 600;
function truncateToastBody(body, maxLines = TOAST_BODY_MAX_LINES) {
  const lines = body.split(`
`);
  if (lines.length <= maxLines) {
    return body;
  }
  const kept = lines.slice(0, maxLines - 1);
  const remaining = lines.length - maxLines + 1;
  return kept.join(`
`) + `
... and ${remaining} more`;
}
function truncateToastSummary(summary, maxChars = TOAST_SUMMARY_MAX_CHARS) {
  if (summary.length <= maxChars) {
    return summary;
  }
  return summary.slice(0, maxChars - 3) + "...";
}
function buildMinimalMessage(state) {
  return formatStatsHeader(state.stats.totalCompressTokens, state.stats.compressTokenCounter);
}
function buildDetailedMessage(args) {
  const {
    state,
    toolIds,
    itemCount,
    topic,
    summary,
    startResult,
    endResult,
    totalMessages,
    rangeTokenEstimate,
    showCompression
  } = args;
  let message = formatStatsHeader(state.stats.totalCompressTokens, state.stats.compressTokenCounter);
  const rangeTokenCount = rangeTokenEstimate ?? state.stats.compressTokenCounter;
  const rangeTokenCountLabel = `~${formatTokenCount(rangeTokenCount)}`;
  const progressBar = formatProgressBar(totalMessages, startResult.messageIndex, endResult.messageIndex, 25);
  message += `

\u25A3 Compressing (${rangeTokenCountLabel}) ${progressBar}`;
  message += `
\u2192 Topic: ${topic}`;
  message += `
\u2192 Items: ${itemCount} ${itemCount === 1 ? "entry" : "entries"}`;
  message += toolIds.length > 0 ? ` and ${toolIds.length} tools condensed` : " condensed";
  if (showCompression) {
    message += `
\u2192 Compression: ${summary}`;
  }
  return message;
}
async function sendCompressNotification(client, logger, config, state, sessionId, toolIds, itemCount, topic, summary, startResult, endResult, totalMessages, params, rangeTokenEstimate) {
  if (config.notification === "off") {
    return false;
  }
  const message = config.notification === "minimal" ? buildMinimalMessage(state) : buildDetailedMessage({
    state,
    toolIds,
    itemCount,
    topic,
    summary,
    startResult,
    endResult,
    totalMessages,
    rangeTokenEstimate,
    showCompression: config.tools.compress.showCompression
  });
  if (config.notificationType === "toast") {
    let toastMessage = message;
    if (config.tools.compress.showCompression) {
      const truncatedSummary = truncateToastSummary(summary);
      if (truncatedSummary !== summary) {
        toastMessage = toastMessage.replace(`
\u2192 Compression: ${summary}`, `
\u2192 Compression: ${truncatedSummary}`);
      }
    }
    toastMessage = config.notification === "minimal" ? toastMessage : truncateToastBody(toastMessage);
    const shown = await showToast(client, {
      title: "Compress Notification",
      message: toastMessage,
      variant: "info",
      duration: 5000
    });
    if (shown) {
      return true;
    }
  }
  await sendIgnoredMessage(client, sessionId, message, params, logger);
  return true;
}
async function sendIgnoredMessage(client, sessionID, text, params, logger) {
  const agent = params.agent || undefined;
  const variant = params.variant || undefined;
  const model = params.providerId && params.modelId ? {
    providerID: params.providerId,
    modelID: params.modelId
  } : undefined;
  try {
    await promptSession(client, {
      sessionId: sessionID,
      noReply: true,
      agent,
      model,
      variant,
      parts: [
        {
          type: "text",
          text,
          ignored: true
        }
      ]
    });
  } catch (error) {
    logger.error("Failed to send notification", { error: error.message });
  }
}

// lib/messages/legacy-residue.ts
var MANAGE_PROMPT_SIGNATURE = /compress (?:manage|squash)/i;
var CONTEXT_MANAGEMENT_MARKER = /CONTEXT (?:MANAGEMENT|SQUASH) REQUESTED/;
var STATUS_NOTIFICATION_HEADER = /\u25A3 Context Compress \|/;
var STATUS_NOTIFICATION_PROGRESS = /\u25A3 Compressing/;
var COMPRESSION_ONLY_REQUEST = /^(?:(?:please|pls|kindly|can you|could you|would you|now|thanks|thank you|context|conversation|history|manage|management|compress|compression|compact|cleanup|clean|up|prune|summari[sz]e|old|older|completed|past|previous|messages|turns|work|range|ranges|blocks?|cache|the|my|this|that|our|session|for|to|and|all|some|a|an|it|do|run|just|again)[\s,.;:!?-]*)+$/i;
var EMBEDDED_USER_MESSAGE = /<user-message>\s*([\s\S]*?)\s*<\/user-message>/;
function getMessageText(message) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join(`
`);
}
function hasToolPart(message, predicate) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some((part) => part.type === "tool" && typeof part.tool === "string" && predicate(part.tool));
}
var isCompressToolName = (tool) => tool === "compress_map" || tool === "compress" || tool === "squash";
function isManagePromptMessage(message) {
  if (message.info.role !== "user" || isIgnoredUserMessage(message)) {
    return false;
  }
  const text = getMessageText(message);
  return MANAGE_PROMPT_SIGNATURE.test(text) && CONTEXT_MANAGEMENT_MARKER.test(text);
}
function extractEmbeddedUserText(message) {
  const match = EMBEDDED_USER_MESSAGE.exec(getMessageText(message));
  const text = match?.[1]?.trim();
  return text ? text : undefined;
}
function isStatusNotificationMessage(message) {
  if (message.info.role !== "user" || !isIgnoredUserMessage(message)) {
    return false;
  }
  const text = getMessageText(message);
  return STATUS_NOTIFICATION_HEADER.test(text) || STATUS_NOTIFICATION_PROGRESS.test(text);
}
function isCompressionOnlyUserRequest(message) {
  if (message.info.role !== "user" || isIgnoredUserMessage(message)) {
    return false;
  }
  const text = getMessageText(message).trim();
  if (!text) {
    return false;
  }
  return COMPRESSION_ONLY_REQUEST.test(text);
}
function isStrongArtifact(message) {
  return isManagePromptMessage(message);
}
function isWeakArtifact(message) {
  if (message.info.role === "assistant") {
    return !hasToolPart(message, (tool) => !isCompressToolName(tool));
  }
  if (message.info.role === "user") {
    if (isIgnoredUserMessage(message)) {
      return true;
    }
    return isCompressionOnlyUserRequest(message);
  }
  return false;
}
function buildLegacyResidueSuppressionPlan(rawMessages) {
  const suppressed = new Set;
  const retainedTextByMessageId = new Map;
  let i = 0;
  while (i < rawMessages.length) {
    if (isStatusNotificationMessage(rawMessages[i])) {
      suppressed.add(rawMessages[i].info.id);
      i++;
      continue;
    }
    if (!isStrongArtifact(rawMessages[i])) {
      i++;
      continue;
    }
    let start = i;
    while (start > 0 && !suppressed.has(rawMessages[start - 1].info.id) && isCompressionOnlyUserRequest(rawMessages[start - 1])) {
      start--;
    }
    let end = i;
    while (end + 1 < rawMessages.length) {
      const candidate = rawMessages[end + 1];
      if (isStrongArtifact(candidate) || isWeakArtifact(candidate)) {
        end++;
        continue;
      }
      break;
    }
    if (end + 1 >= rawMessages.length) {
      break;
    }
    for (let k = start;k <= end; k++) {
      const candidate = rawMessages[k];
      const embeddedText = isManagePromptMessage(candidate) ? extractEmbeddedUserText(candidate) : undefined;
      if (embeddedText) {
        retainedTextByMessageId.set(candidate.info.id, embeddedText);
        continue;
      }
      suppressed.add(candidate.info.id);
    }
    i = end + 1;
  }
  return { suppressedMessageIds: suppressed, retainedTextByMessageId };
}

// lib/messages/blocks.ts
function orderCompressBlocks(rawMessages, summaries) {
  const positionsByMessageId = new Map;
  for (let index = 0;index < rawMessages.length; index++) {
    const messageId = rawMessages[index].info.id;
    const positions = positionsByMessageId.get(messageId) ?? [];
    positions.push(index);
    positionsByMessageId.set(messageId, positions);
  }
  const seenAnchors = new Set;
  const ordered = summaries.map((summary) => {
    const positions = positionsByMessageId.get(summary.anchorMessageId);
    if (seenAnchors.has(summary.anchorMessageId) || positions?.length !== 1) {
      throw new Error("could not reconcile an existing compressed block unambiguously with the current transcript. Nothing changed.");
    }
    seenAnchors.add(summary.anchorMessageId);
    return {
      summary,
      anchorIndex: positions[0]
    };
  });
  ordered.sort((left, right) => left.anchorIndex - right.anchorIndex);
  return ordered.map((block, index) => ({
    ...block,
    label: `b${index}`
  }));
}
function formatCompressBlockContent(block) {
  return `${COMPRESS_SUMMARY_PREFIX}[${block.label}]

${block.summary.summary}`;
}

// lib/messages/compress-transform.ts
var COMPRESSED_TOOL_OUTPUT_REPLACEMENT = "[Output removed to save context - information superseded or no longer needed]";
var COMPRESSED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]";
var COMPRESSED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]";
var applyCompressTransforms = (state, logger, messages) => {
  filterCompressedRanges(state, logger, messages);
  stripCompressedTools(state, messages);
  stripToolOutputs(state, messages);
  stripToolInputs(state, messages);
  stripToolErrors(state, messages);
};
function isVisibleUserMessage(message) {
  return message.info.role === "user" && message.info.sourceType !== "synthetic" && !isIgnoredUserMessage(message);
}
function findActiveManagementTurn(state, rawMessages) {
  if (!state.managementTurns?.length) {
    return;
  }
  const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]));
  let best;
  for (const turn of state.managementTurns) {
    if (turn.completedAt) {
      continue;
    }
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex === undefined) {
      continue;
    }
    let bounded = false;
    for (let i = triggerIndex + 1;i < rawMessages.length; i++) {
      if (isVisibleUserMessage(rawMessages[i])) {
        bounded = true;
        break;
      }
    }
    if (bounded) {
      continue;
    }
    if (!best || triggerIndex > best.triggerIndex) {
      best = { turn, triggerIndex };
    }
  }
  return best;
}
function collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, endExclusive, retainedText, suppressedMessageIds, retainedTextByMessageId) {
  for (let i = triggerIndex;i < endExclusive; i++) {
    const message = rawMessages[i];
    if (i === triggerIndex && retainedText) {
      retainedTextByMessageId.set(message.info.id, retainedText);
      continue;
    }
    suppressedMessageIds.add(message.info.id);
  }
}
function buildManagementTurnSuppressionPlan(state, rawMessages) {
  const suppressedMessageIds = new Set;
  const retainedTextByMessageId = new Map;
  if (!state.managementTurns?.length) {
    return { suppressedMessageIds, retainedTextByMessageId };
  }
  const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]));
  for (const turn of state.managementTurns) {
    if (turn.cleanupVersion === 2)
      continue;
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex === undefined) {
      continue;
    }
    const retainedText = typeof turn.retainedText === "string" && turn.retainedText.trim().length > 0 ? turn.retainedText : undefined;
    let nextUserIndex = -1;
    for (let i = triggerIndex + 1;i < rawMessages.length; i++) {
      if (isVisibleUserMessage(rawMessages[i])) {
        nextUserIndex = i;
        break;
      }
    }
    if (nextUserIndex !== -1) {
      collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, nextUserIndex, retainedText, suppressedMessageIds, retainedTextByMessageId);
      continue;
    }
    const completedIndex = turn.completedAt && turn.completedMessageId ? indexByMessageId.get(turn.completedMessageId) : undefined;
    if (completedIndex === undefined || completedIndex <= triggerIndex) {
      continue;
    }
    collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, completedIndex, retainedText, suppressedMessageIds, retainedTextByMessageId);
    for (let i = completedIndex + 1;i < rawMessages.length; i++) {
      const candidate = rawMessages[i];
      if (isVisibleUserMessage(candidate)) {
        break;
      }
      if (candidate.info.role === "user" && isIgnoredUserMessage(candidate)) {
        suppressedMessageIds.add(candidate.info.id);
      }
    }
  }
  return { suppressedMessageIds, retainedTextByMessageId };
}
function completionTool(turn) {
  return turn.source === "squash" ? "squash" : "compress";
}
function withoutCompletionTool(message, turn) {
  return message.parts.filter((part) => !(part.type === "tool" && part.tool === completionTool(turn)));
}
function buildV2CleanupPlan(state, rawMessages) {
  const suppressedMessageIds = new Set;
  const retainedTextByMessageId = new Map;
  const retainedPartsByMessageId = new Map;
  const protectedMessageIds = new Set;
  const turns = state.managementTurns.filter((turn) => turn.cleanupVersion === 2);
  const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]));
  const active = [...turns].reverse().find((turn) => {
    if (turn.completedAt)
      return false;
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex === undefined)
      return false;
    return !rawMessages.slice(triggerIndex + 1).some(isVisibleUserMessage);
  });
  const newestCompleted = [...turns].reverse().find((turn) => turn.completedAt && turn.completedMessageId);
  const visibleAnchors = turns.flatMap((turn) => [indexByMessageId.get(turn.triggerMessageId), turn.completedMessageId ? indexByMessageId.get(turn.completedMessageId) : undefined].filter((index) => index !== undefined));
  const firstV2Index = visibleAnchors.length > 0 ? Math.min(...visibleAnchors) : undefined;
  if (firstV2Index !== undefined) {
    for (let i = firstV2Index;i < rawMessages.length; i++) {
      protectedMessageIds.add(rawMessages[i].info.id);
    }
  }
  for (const turn of turns) {
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex !== undefined && turn !== active) {
      if (turn.retainedText)
        retainedTextByMessageId.set(turn.triggerMessageId, turn.retainedText);
      else
        suppressedMessageIds.add(turn.triggerMessageId);
    }
    const completedIndex = turn.completedMessageId ? indexByMessageId.get(turn.completedMessageId) : undefined;
    if (completedIndex !== undefined && (active || turn !== newestCompleted)) {
      const message = rawMessages[completedIndex];
      const parts = withoutCompletionTool(message, turn);
      if (parts.length > 0)
        retainedPartsByMessageId.set(message.info.id, parts);
      else
        suppressedMessageIds.add(message.info.id);
    }
    if (triggerIndex === undefined)
      continue;
    for (let i = triggerIndex + 1;i < rawMessages.length; i++) {
      const message = rawMessages[i];
      if (isVisibleUserMessage(message))
        break;
      if (message.info.role === "user" && isIgnoredUserMessage(message)) {
        suppressedMessageIds.add(message.info.id);
        continue;
      }
      if (turn !== active && !(turn === newestCompleted && message.info.id === turn.completedMessageId)) {
        const parts = withoutCompletionTool(message, turn);
        if (parts.length === message.parts.length)
          continue;
        if (parts.length > 0)
          retainedPartsByMessageId.set(message.info.id, parts);
        else
          suppressedMessageIds.add(message.info.id);
      }
    }
  }
  for (const messageId of suppressedMessageIds)
    protectedMessageIds.delete(messageId);
  return {
    suppressedMessageIds,
    retainedTextByMessageId,
    retainedPartsByMessageId,
    protectedMessageIds
  };
}
function stripV2MachineryForCompressionSelection(messages, state) {
  const triggers = new Map(state.managementTurns.filter((turn) => turn.cleanupVersion === 2).map((turn) => [turn.triggerMessageId, turn]));
  const completions = new Map(state.managementTurns.filter((turn) => turn.cleanupVersion === 2 && turn.completedMessageId).map((turn) => [turn.completedMessageId, turn]));
  return messages.flatMap((message) => {
    const trigger = triggers.get(message.info.id);
    if (trigger && !trigger.retainedText)
      return [];
    const completion = completions.get(message.info.id);
    if (!completion)
      return [message];
    const parts = withoutCompletionTool(message, completion);
    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}
function createRetainedUserMessage(message, retainedText) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const textPart = parts.find((part) => part.type === "text");
  const retainedPart = textPart ? { ...textPart, text: retainedText } : {
    id: `prt_retained_${message.info.id}`,
    sessionID: message.info.sessionID,
    messageID: message.info.id,
    type: "text",
    text: retainedText
  };
  return {
    ...message,
    parts: [retainedPart]
  };
}
var transformMessagesForSearch = (rawMessages, state, logger) => {
  const legacyPlan = buildLegacyResidueSuppressionPlan(rawMessages);
  const v2Plan = buildV2CleanupPlan(state, rawMessages);
  const hasLegacyFindings = legacyPlan.suppressedMessageIds.size > 0 || legacyPlan.retainedTextByMessageId.size > 0;
  if (!state.compressed.messageIds?.size && !state.compressSummaries.length && !state.managementTurns?.length && !hasLegacyFindings && v2Plan.suppressedMessageIds.size === 0 && v2Plan.retainedPartsByMessageId.size === 0) {
    return {
      transformed: [...rawMessages],
      syntheticMap: new Map
    };
  }
  const transformed = [];
  const syntheticMap = new Map;
  const orderedBlocks = orderCompressBlocks(rawMessages, state.compressSummaries);
  const blocksByAnchorId = new Map(orderedBlocks.map((block) => [block.summary.anchorMessageId, block]));
  const managementSuppression = buildManagementTurnSuppressionPlan(state, rawMessages);
  for (const [messageId, retainedText] of v2Plan.retainedTextByMessageId) {
    managementSuppression.retainedTextByMessageId.set(messageId, retainedText);
  }
  for (const messageId of v2Plan.suppressedMessageIds) {
    managementSuppression.suppressedMessageIds.add(messageId);
  }
  for (const [messageId, retainedText] of legacyPlan.retainedTextByMessageId) {
    if (!managementSuppression.retainedTextByMessageId.has(messageId)) {
      managementSuppression.retainedTextByMessageId.set(messageId, retainedText);
    }
  }
  for (const messageId of legacyPlan.suppressedMessageIds) {
    if (!managementSuppression.retainedTextByMessageId.has(messageId) && !v2Plan.retainedPartsByMessageId.has(messageId) && !v2Plan.protectedMessageIds.has(messageId)) {
      managementSuppression.suppressedMessageIds.add(messageId);
    }
  }
  for (const messageId of managementSuppression.retainedTextByMessageId.keys()) {
    managementSuppression.suppressedMessageIds.delete(messageId);
  }
  for (const messageId of v2Plan.retainedPartsByMessageId.keys()) {
    managementSuppression.suppressedMessageIds.delete(messageId);
  }
  for (const messageId of v2Plan.protectedMessageIds) {
    managementSuppression.suppressedMessageIds.delete(messageId);
  }
  for (let i = 0;i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    const msgId = msg.info.id;
    const block = blocksByAnchorId.get(msgId);
    if (block) {
      const summary = block.summary;
      const userMessage = getLastUserMessage(rawMessages, i);
      if (userMessage) {
        const userInfo = userMessage.info;
        const summaryContent = formatCompressBlockContent(block);
        const syntheticMessage = createSyntheticUserMessage(userMessage, summaryContent, userInfo.variant, summary.anchorMessageId);
        transformed.push(syntheticMessage);
        syntheticMap.set(syntheticMessage.info.id, summary);
        logger.info("Injected compress summary", {
          anchorMessageId: msgId,
          summaryLength: summary.summary.length
        });
      } else {
        logger.warn("No user message found for compress summary", {
          anchorMessageId: msgId
        });
      }
    }
    const retainedParts = v2Plan.retainedPartsByMessageId.get(msgId);
    if (retainedParts && !state.compressed.messageIds.has(msgId)) {
      transformed.push({ ...msg, parts: retainedParts });
      continue;
    }
    if (managementSuppression.suppressedMessageIds.has(msgId)) {
      continue;
    }
    const retainedText = managementSuppression.retainedTextByMessageId.get(msgId);
    if (retainedText && !state.compressed.messageIds.has(msgId)) {
      transformed.push(createRetainedUserMessage(msg, retainedText));
      continue;
    }
    if (state.compressed.messageIds.has(msgId)) {
      continue;
    }
    transformed.push(msg);
  }
  return {
    transformed,
    syntheticMap
  };
};
var stripCompressedTools = (state, messages) => {
  const messagesToRemove = [];
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const partsToRemove = [];
    for (const part of parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (!state.compressed.toolIds.has(part.callID)) {
        continue;
      }
      if (part.tool !== "edit" && part.tool !== "write") {
        continue;
      }
      partsToRemove.push(part.callID);
    }
    if (partsToRemove.length === 0) {
      continue;
    }
    msg.parts = parts.filter((part) => part.type !== "tool" || !partsToRemove.includes(part.callID));
    if (msg.parts.length === 0) {
      messagesToRemove.push(msg.info.id);
    }
  }
  if (messagesToRemove.length > 0) {
    const result = messages.filter((msg) => !messagesToRemove.includes(msg.info.id));
    messages.length = 0;
    messages.push(...result);
  }
};
var stripToolOutputs = (state, messages) => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (!state.compressed.toolIds.has(part.callID)) {
        continue;
      }
      if (part.state.status !== "completed") {
        continue;
      }
      if (part.tool === "question" || part.tool === "edit" || part.tool === "write") {
        continue;
      }
      part.state.output = COMPRESSED_TOOL_OUTPUT_REPLACEMENT;
    }
  }
};
var stripToolInputs = (state, messages) => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (!state.compressed.toolIds.has(part.callID)) {
        continue;
      }
      if (part.state.status !== "completed") {
        continue;
      }
      if (part.tool !== "question") {
        continue;
      }
      if (typeof part.state.input === "object" && part.state.input.questions !== undefined) {
        part.state.input.questions = COMPRESSED_QUESTION_INPUT_REPLACEMENT;
      }
    }
  }
};
var stripToolErrors = (state, messages) => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (!state.compressed.toolIds.has(part.callID)) {
        continue;
      }
      if (part.state.status !== "error") {
        continue;
      }
      const input = part.state.input;
      if (input && typeof input === "object") {
        for (const key of Object.keys(input)) {
          if (typeof input[key] === "string") {
            input[key] = COMPRESSED_TOOL_ERROR_INPUT_REPLACEMENT;
          }
        }
      }
    }
  }
};
var filterCompressedRanges = (state, logger, messages) => {
  const { transformed } = transformMessagesForSearch(messages, state, logger);
  messages.length = 0;
  messages.push(...transformed);
};

// lib/messages/context-map.ts
function deriveProtectedTailMessageIds(messages, protectedTurns) {
  if (protectedTurns <= 0 || messages.length === 0)
    return [];
  let protectedStart = 0;
  let stepCount = 0;
  for (let index = messages.length - 1;index >= 0; index--) {
    protectedStart = index;
    const parts = Array.isArray(messages[index].parts) ? messages[index].parts : [];
    stepCount += parts.filter((part) => part.type === "step-start").length;
    if (stepCount >= protectedTurns)
      break;
  }
  if (stepCount === 0) {
    protectedStart = Math.max(0, messages.length - protectedTurns);
  }
  return messages.slice(protectedStart).map((message) => message.info.id);
}
function selectDeterministicCompressionSpan(rawHistory, state, logger, protectedTurns) {
  const search = transformMessagesForSearch(rawHistory, state, logger);
  const transformed = stripV2MachineryForCompressionSelection(search.transformed, state);
  const syntheticMap = search.syntheticMap;
  const representedBlockAnchors = new Set([...syntheticMap.values()].map((summary) => summary.anchorMessageId));
  const missingBlock = state.compressSummaries.find((summary) => !representedBlockAnchors.has(summary.anchorMessageId));
  if (missingBlock) {
    throw new Error("compress could not reconcile an existing compressed block with the current transcript. Nothing was compressed.");
  }
  let newestBlockIndex = -1;
  for (let index = transformed.length - 1;index >= 0; index--) {
    if (syntheticMap.has(transformed[index].info.id)) {
      newestBlockIndex = index;
      break;
    }
  }
  const existingBlockMessageIds = new Set;
  for (const summary of state.compressSummaries) {
    existingBlockMessageIds.add(summary.anchorMessageId);
    for (const messageId of summary.messageIds)
      existingBlockMessageIds.add(messageId);
  }
  const candidates = transformed.slice(newestBlockIndex + 1).filter((message) => !syntheticMap.has(message.info.id) && !existingBlockMessageIds.has(message.info.id));
  const protectedMessageIds = deriveProtectedTailMessageIds(candidates, protectedTurns);
  const protectedIds = new Set(protectedMessageIds);
  const messages = candidates.filter((message) => !protectedIds.has(message.info.id));
  return {
    messages,
    messageIds: messages.map((message) => message.info.id),
    protectedMessageIds
  };
}
function deriveAutomaticProtectedTail(rawMessages, state, logger, protectedTurns) {
  const span = selectDeterministicCompressionSpan(rawMessages, state, logger, protectedTurns);
  return {
    protectedMessageIds: span.protectedMessageIds,
    hasSelectableMessages: span.messageIds.length > 0
  };
}

// lib/commands/manage.ts
var COMPRESSION_ONLY_TEXT = /^(?:(?:please|pls|kindly|can you|could you|would you|now|thanks|thank you|context|conversation|history|manage|management|compress|compression|compact|cleanup|clean|up|prune|summari[sz]e|old|older|completed|past|previous|messages|turns|work|range|ranges|blocks?|cache|the|my|this|that|our|session|for|to|and|all|some|a|an|it|do|run|just)[\s,.;:!?-]*)+$/i;
var LEADING_COMPRESSION_REQUEST = /^\s*(?:(?:please|pls|kindly)\s+)?(?:compress|manage|compact|clean\s+up|cleanup|prune|summari[sz]e)(?:\s+(?:the|this|that|our|my|old|older|past|previous|completed|conversation|context|history|messages|turns|work|session|blocks?|ranges?))*\s*(?:now|please)?\s*(?:[:;,.!-]+\s*)/i;
var LEADING_COMPRESSION_REQUEST_WITH_CONJUNCTION = /^\s*(?:(?:please|pls|kindly)\s+)?(?:compress|manage|compact|clean\s+up|cleanup|prune|summari[sz]e)(?:\s+(?:the|this|that|our|my|old|older|past|previous|completed|conversation|context|history|messages|turns|work|session|blocks?|ranges?))*\s+(?:and|also|but)\b\s*/i;
function trimCommandBoundary(text) {
  return text.replace(/^[\s:;,.|\-]+/, "").replace(/\s+$/, "");
}
function extractManageCommandResidual(args) {
  const withoutSubcommand = (args || "").replace(/^\s*manage\b/i, "");
  const initial = trimCommandBoundary(withoutSubcommand);
  if (!initial) {
    return;
  }
  let residual = initial;
  const stripped = residual.replace(LEADING_COMPRESSION_REQUEST, "").replace(LEADING_COMPRESSION_REQUEST_WITH_CONJUNCTION, "");
  if (stripped !== residual) {
    residual = stripped.replace(/^\s*(?:and|also|but)\b[\s,]*/i, "");
  }
  residual = trimCommandBoundary(residual);
  if (!residual || COMPRESSION_ONLY_TEXT.test(residual)) {
    return;
  }
  return residual;
}
var ASCENDING_ID_RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
var lastGeneratedMessageIdTimestamp = 0;
var lastGeneratedMessageIdCounter = 0;
function generateLiveOrderedMessageIdSuffix(timestamp = Date.now(), identity) {
  if (!identity) {
    if (timestamp !== lastGeneratedMessageIdTimestamp) {
      lastGeneratedMessageIdTimestamp = timestamp;
      lastGeneratedMessageIdCounter = 0;
    }
    lastGeneratedMessageIdCounter++;
  }
  const current = BigInt(timestamp) * 0x1000n + BigInt(identity ? 0 : lastGeneratedMessageIdCounter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) => Number(value >> BigInt(40 - 8 * index) & 0xffn).toString(16).padStart(2, "0")).join("");
  const random = identity ? createHash2("sha256").update(identity).digest("hex").slice(0, 14) : Array.from({ length: 14 }, () => ASCENDING_ID_RANDOM_CHARS[Math.floor(Math.random() * ASCENDING_ID_RANDOM_CHARS.length)]).join("");
  return time + random;
}
function generateManagePromptMessageId() {
  return `msg_${generateLiveOrderedMessageIdSuffix()}`;
}
function generateAutomaticPromptMessageId(sessionId, trigger) {
  return `msg_${generateLiveOrderedMessageIdSuffix(trigger.time.completed ?? trigger.time.created, JSON.stringify(["automatic-compression", sessionId, trigger.id]))}`;
}
function extractPromptParentIdForLogging(promptResult) {
  const result = promptResult?.data ?? promptResult;
  const info = result?.info;
  if (!info || typeof info !== "object") {
    return;
  }
  return typeof info.parentID === "string" && info.parentID.length > 0 ? info.parentID : undefined;
}
async function sendManageFailureFeedback(client, logger, sessionId, message, params) {
  if (await showToast(client, {
    title: "Compression Management",
    message,
    variant: "error",
    duration: 8000
  })) {
    return;
  }
  if (typeof client?.session?.prompt === "function") {
    await sendIgnoredMessage(client, sessionId, message, params, logger);
    return;
  }
  logger.error("Unable to surface compression management error to user", { sessionId, message });
}
async function handleManageCommand(ctx) {
  if (ctx.config.tools.compress.permission === "deny") {
    await sendManageFailureFeedback(ctx.client, ctx.logger, ctx.sessionId, "Compression management did not start because compress is denied. Enable the compression tool, then run `/compress manage` again.", getCurrentParams(ctx.state, ctx.messages, ctx.logger));
    return;
  }
  await startManagementTurn({
    client: ctx.client,
    stateManager: ctx.stateManager,
    state: ctx.state,
    logger: ctx.logger,
    sessionId: ctx.sessionId,
    messages: ctx.messages,
    systemPrompt: renderSystemPrompt(),
    retainedText: extractManageCommandResidual(ctx.arguments)
  });
}
async function stageManagementTurnWithinLock(ctx) {
  const { client, stateManager, state, logger, sessionId, messages } = ctx;
  const currentParams = getCurrentParams(state, messages, logger);
  if (!state.persistenceSynchronized) {
    return async () => {
      await sendManageFailureFeedback(client, logger, sessionId, "Compression management could not start because saved session state could not be loaded.", currentParams);
      return false;
    };
  }
  const automaticTail = ctx.source === "automatic" ? deriveAutomaticProtectedTail(messages, state, logger, ctx.protectedTurns ?? 0) : undefined;
  if (ctx.source === "automatic" && !automaticTail?.hasSelectableMessages) {
    logger.warn("Automatic compression skipped because the protected tail covers all selectable messages", {
      sessionId,
      protectedTurns: ctx.protectedTurns ?? 0
    });
    return;
  }
  const messageParts = [];
  if (ctx.systemPrompt) {
    messageParts.push({ type: "text", text: ctx.systemPrompt });
  }
  if (ctx.retainedText) {
    messageParts.push({
      type: "text",
      text: ["<user-message>", ctx.retainedText, "</user-message>"].join(`
`)
    });
  }
  const trigger = ctx.source === "automatic" ? messages.find((message) => message.info.id === ctx.triggeredByMessageId) : undefined;
  if (ctx.source === "automatic" && !trigger) {
    throw new Error("Automatic compression trigger is missing from projected history");
  }
  const triggerMessageId = trigger ? generateAutomaticPromptMessageId(sessionId, trigger.info) : generateManagePromptMessageId();
  const managementTurn = {
    triggerMessageId,
    cleanupVersion: 2,
    ...ctx.retainedText ? { retainedText: ctx.retainedText } : {},
    ...ctx.source ? { source: ctx.source } : {},
    ...ctx.triggeredByMessageId ? { triggeredByMessageId: ctx.triggeredByMessageId } : {},
    ...typeof ctx.contextTokens === "number" ? { contextTokens: ctx.contextTokens } : {},
    ...typeof ctx.thresholdTokens === "number" ? { thresholdTokens: ctx.thresholdTokens } : {}
  };
  const candidateState = {
    ...state,
    managementTurns: [...state.managementTurns, managementTurn],
    compressionMapSnapshot: undefined
  };
  const statePersisted = await saveSessionState(candidateState, logger);
  if (!statePersisted) {
    logger.error("Manage command aborted because cleanup state could not be persisted", {
      sessionId,
      triggerMessageId
    });
    return async () => {
      await sendManageFailureFeedback(client, logger, sessionId, "Compression management could not start: cleanup state could not be saved.", currentParams);
      return false;
    };
  }
  commitDurableSessionState(state, candidateState);
  const model = currentParams.providerId && currentParams.modelId ? {
    providerID: currentParams.providerId,
    modelID: currentParams.modelId
  } : undefined;
  return async () => {
    let promptResult;
    try {
      promptResult = await promptSession(client, {
        sessionId,
        agent: currentParams.agent,
        model,
        variant: currentParams.variant,
        parts: messageParts,
        messageId: triggerMessageId,
        metadata: { "opencode.context-compress.management": true }
      });
    } catch (err) {
      const rollbackResult = await stateManager.runExclusive(sessionId, async () => {
        const currentTurn = state.managementTurns.find((turn) => turn.triggerMessageId === triggerMessageId);
        if (!currentTurn)
          return "removed";
        if (currentTurn.completedAt)
          return "completed";
        const rollbackState = {
          ...state,
          managementTurns: state.managementTurns.filter((turn) => turn.triggerMessageId !== triggerMessageId)
        };
        const persisted = await saveSessionState(rollbackState, logger);
        if (!persisted)
          return "failed";
        commitDurableSessionState(state, rollbackState);
        return "removed";
      });
      logger.error("Manage command failed", { error: err?.message });
      if (rollbackResult === "completed") {
        logger.warn("Manage prompt failed after compression completed; preserving the completed turn marker", {
          sessionId,
          triggerMessageId
        });
      } else if (rollbackResult === "failed") {
        logger.error("Manage prompt failure marker could not be rolled back", {
          sessionId,
          triggerMessageId
        });
      }
      await sendManageFailureFeedback(client, logger, sessionId, rollbackResult === "completed" ? `The compression management prompt reported an error after compression completed: ${err?.message || "the prompt failed."} The completed state was preserved.` : rollbackResult === "removed" ? `Compression management could not start: ${err?.message || "the prompt failed."}` : `Compression management could not start: ${err?.message || "the prompt failed."} Its saved cleanup marker could not be removed.`, currentParams);
      return false;
    }
    const returnedParentId = extractPromptParentIdForLogging(promptResult);
    if (returnedParentId && returnedParentId !== triggerMessageId) {
      logger.warn("Manage prompt result parentID differs from the generated trigger ID; keeping the generated ID as the cleanup anchor", {
        sessionId,
        triggerMessageId,
        returnedParentId
      });
    }
    logger.info("Sent compression context to agent", {
      sessionId,
      triggerMessageId,
      source: ctx.source ?? "manual"
    });
    return true;
  };
}
async function startManagementTurn(ctx) {
  const staged = await ctx.stateManager.runExclusive(ctx.sessionId, () => stageManagementTurnWithinLock(ctx));
  return staged ? staged() : false;
}
// lib/auto-policy.ts
var POST_COMPRESSION_COOLDOWN_RESPONSES = 3;
function resolveEffectiveAutoCompressionPolicy(config, state) {
  const enabledOverride = state.autoCompressionEnabledOverride;
  const tokenThresholdOverride = state.autoCompressionTokenThresholdOverride;
  const contextWindowRatioOverride = state.autoCompressionContextWindowRatioOverride;
  return {
    globallyEnabled: config.enabled,
    enabled: config.enabled && (enabledOverride ?? config.enabled),
    enabledSource: config.enabled && enabledOverride !== undefined ? "session override" : "config",
    tokenThreshold: tokenThresholdOverride ?? config.tokenThreshold,
    tokenThresholdSource: tokenThresholdOverride !== undefined ? "session override" : "config",
    contextWindowRatio: contextWindowRatioOverride ?? config.contextWindowRatio,
    contextWindowRatioSource: contextWindowRatioOverride !== undefined ? "session override" : "config"
  };
}
function messageContainsCompressCall(message) {
  return !!message?.parts?.some((part) => part.type === "tool" && part.tool === "compress");
}
function isVisibleUserMessage2(message) {
  return message.info.role === "user" && message.info.sourceType !== "synthetic" && !isIgnoredUserMessage(message);
}
function collectManagementTurnMessageIds(state, messages) {
  const managementMessageIds = new Set;
  const indexByMessageId = new Map(messages.map((message, index) => [message.info.id, index]));
  for (const turn of state.managementTurns) {
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex === undefined)
      continue;
    const completedIndex = turn.completedAt && turn.completedMessageId ? indexByMessageId.get(turn.completedMessageId) : undefined;
    let endExclusive;
    if (completedIndex !== undefined && completedIndex > triggerIndex) {
      endExclusive = completedIndex + 1;
    } else {
      endExclusive = messages.length;
      for (let i = triggerIndex + 1;i < messages.length; i++) {
        if (isVisibleUserMessage2(messages[i])) {
          endExclusive = i;
          break;
        }
      }
    }
    for (let i = triggerIndex;i < endExclusive; i++) {
      managementMessageIds.add(messages[i].info.id);
    }
  }
  return managementMessageIds;
}
function getPostCompressionCooldownRemaining(state, messages) {
  const anchorMessageId = state.compressionCooldownAfterMessageId;
  if (!anchorMessageId)
    return 0;
  const anchorIndex = messages.findIndex((message) => message.info.id === anchorMessageId);
  if (anchorIndex === -1)
    return 0;
  const eligibleMessageIds = collectEligibleCooldownMessageIds(state, messages, anchorIndex);
  return Math.max(0, POST_COMPRESSION_COOLDOWN_RESPONSES - eligibleMessageIds.length);
}
function collectEligibleCooldownMessageIds(state, messages, anchorIndex) {
  const managementMessageIds = collectManagementTurnMessageIds(state, messages);
  const seen = new Set;
  const eligibleMessageIds = [];
  for (let i = anchorIndex + 1;i < messages.length; i++) {
    const message = messages[i];
    const info = message.info;
    if (info.role !== "assistant" || info.summary === true || info.error || !info.time?.completed || managementMessageIds.has(info.id)) {
      continue;
    }
    if (!seen.has(info.id)) {
      seen.add(info.id);
      eligibleMessageIds.push(info.id);
    }
  }
  return eligibleMessageIds;
}
function isMessageWithinPostCompressionCooldown(state, messages, messageId) {
  const anchorMessageId = state.compressionCooldownAfterMessageId;
  if (!anchorMessageId)
    return false;
  const anchorIndex = messages.findIndex((message) => message.info.id === anchorMessageId);
  if (anchorIndex === -1)
    return false;
  const eligibleMessageIds = collectEligibleCooldownMessageIds(state, messages, anchorIndex);
  const messagePosition = eligibleMessageIds.indexOf(messageId);
  if (messagePosition !== -1) {
    return messagePosition < POST_COMPRESSION_COOLDOWN_RESPONSES;
  }
  return eligibleMessageIds.length < POST_COMPRESSION_COOLDOWN_RESPONSES;
}

// lib/auto-compression.ts
function positiveFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function getAssistantContextTokens(tokens) {
  if (!tokens)
    return 0;
  const reportedTotal = positiveFinite(tokens.total);
  if (reportedTotal > 0)
    return reportedTotal;
  return positiveFinite(tokens.input) + positiveFinite(tokens.output) + positiveFinite(tokens.reasoning) + positiveFinite(tokens.cache?.read) + positiveFinite(tokens.cache?.write);
}
function resolveAutomaticCompressionThreshold(contextTokens, config, contextLimit) {
  const normalizedContextLimit = positiveFinite(contextLimit) || undefined;
  const relativeThresholdTokens = normalizedContextLimit ? Math.floor(normalizedContextLimit * config.contextWindowRatio) : undefined;
  const thresholdTokens = relativeThresholdTokens ? Math.min(relativeThresholdTokens, config.tokenThreshold) : config.tokenThreshold;
  return {
    contextTokens,
    thresholdTokens,
    relativeThresholdTokens,
    contextLimit: normalizedContextLimit,
    reason: relativeThresholdTokens !== undefined && relativeThresholdTokens <= config.tokenThreshold ? "context-window-ratio" : "absolute-token-threshold"
  };
}
function findContextLimit(stateManager, info) {
  const cached = stateManager.get(info.sessionID).modelContext;
  if (!cached)
    return;
  if (info.providerID && cached.providerId !== info.providerID)
    return;
  if (info.modelID && cached.modelId !== info.modelID)
    return;
  return cached.contextLimit;
}
function formatThresholdReason(result, ratio) {
  return result.reason === "context-window-ratio" ? `${Math.round(ratio * 100)}% of the model-reported context window` : "the system-wide absolute token limit";
}
function createAutomaticCompressionEventHandler(client, stateManager, logger, config, acceptsSession = async () => true) {
  const started = new Map;
  return async (input) => {
    const outer = isRecord2(input) && isRecord2(input.event) ? input.event : input;
    const event = isRecord2(outer) ? outer : {};
    const data = isRecord2(event.data) ? event.data : {};
    if (event.type === "session.step.started") {
      const model = isRecord2(data.model) ? data.model : {};
      if (typeof data.assistantMessageID === "string" && typeof data.sessionID === "string") {
        started.set(data.assistantMessageID, {
          sessionID: data.sessionID,
          agent: typeof data.agent === "string" ? data.agent : undefined,
          providerID: typeof model.providerID === "string" ? model.providerID : undefined,
          modelID: typeof model.id === "string" ? model.id : undefined
        });
      }
      return;
    }
    const projected = event.type === "session.step.ended" && typeof data.assistantMessageID === "string" ? started.get(data.assistantMessageID) : undefined;
    if (event.type === "session.step.failed") {
      if (typeof data.assistantMessageID === "string")
        started.delete(data.assistantMessageID);
      return;
    }
    if (event.type === "session.step.ended" && typeof data.assistantMessageID === "string") {
      started.delete(data.assistantMessageID);
    }
    const info = projected ? {
      id: data.assistantMessageID,
      sessionID: projected.sessionID,
      role: "assistant",
      agent: projected.agent,
      providerID: projected.providerID,
      modelID: projected.modelID,
      time: { completed: Date.now() },
      tokens: isRecord2(data.tokens) ? data.tokens : undefined
    } : event.type === "session.step.ended" && typeof data.assistantMessageID === "string" && typeof data.sessionID === "string" ? {
      id: data.assistantMessageID,
      sessionID: data.sessionID,
      role: "assistant",
      time: { completed: Date.now() },
      tokens: isRecord2(data.tokens) ? data.tokens : undefined
    } : isRecord2(event.properties) && isRecord2(event.properties.info) ? event.properties.info : undefined;
    if (!config.autoCompression.enabled || config.tools.compress.permission === "deny")
      return;
    if (event.type !== "message.updated" && event.type !== "session.step.ended")
      return;
    if (!info || info.role !== "assistant" || info.summary === true || info.error || !info.time?.completed) {
      return;
    }
    if (!await acceptsSession(info.sessionID, outer))
      return;
    const state = stateManager.get(info.sessionID);
    const contextTokens = getAssistantContextTokens(info.tokens);
    if (state.initialized && state.persistenceSynchronized) {
      const policy = resolveEffectiveAutoCompressionPolicy(config.autoCompression, state);
      const threshold = resolveAutomaticCompressionThreshold(contextTokens, policy, findContextLimit(stateManager, info));
      if (!policy.enabled || contextTokens < threshold.thresholdTokens || state.autoCompressionStarting || state.lastAutoTriggeredMessageId === info.id) {
        return;
      }
    }
    let attemptedStart = false;
    let reserved;
    try {
      reserved = await stateManager.runExclusive(info.sessionID, async () => {
        const messages = await listSessionMessages(client, info.sessionID);
        if (messages.length === 0) {
          logger.warn("Automatic compression skipped because session messages were unavailable", {
            sessionId: info.sessionID,
            messageId: info.id
          });
          return;
        }
        await reconcileSessionLifecycle(state, info.sessionID, logger, messages);
        if (!state.persistenceSynchronized) {
          logger.warn("Automatic compression skipped because session policy could not be loaded", {
            sessionId: info.sessionID
          });
          return;
        }
        const cooldownApplies = isMessageWithinPostCompressionCooldown(state, messages, info.id);
        const policy = resolveEffectiveAutoCompressionPolicy(config.autoCompression, state);
        if (!policy.enabled || config.tools.compress.permission === "deny" || cooldownApplies) {
          return;
        }
        const threshold = resolveAutomaticCompressionThreshold(contextTokens, policy, findContextLimit(stateManager, info));
        if (contextTokens < threshold.thresholdTokens)
          return;
        if (state.autoCompressionStarting || state.lastAutoTriggeredMessageId === info.id || state.managementTurns.some((turn) => turn.source === "automatic" && turn.triggeredByMessageId === info.id) || findActiveManagementTurn(state, messages) || messageContainsCompressCall(messages.find((message) => message.info.id === info.id))) {
          return;
        }
        state.autoCompressionStarting = true;
        state.lastAutoTriggeredMessageId = info.id;
        attemptedStart = true;
        const staged = await stageManagementTurnWithinLock({
          client,
          stateManager,
          state,
          logger,
          sessionId: info.sessionID,
          messages,
          systemPrompt: renderAutomaticSystemPrompt({
            context_tokens: contextTokens.toLocaleString("en-US"),
            threshold_tokens: threshold.thresholdTokens.toLocaleString("en-US"),
            threshold_reason: formatThresholdReason(threshold, policy.contextWindowRatio)
          }),
          source: "automatic",
          triggeredByMessageId: info.id,
          contextTokens,
          thresholdTokens: threshold.thresholdTokens,
          protectedTurns: config.protectedTurns,
          asyncPrompt: true
        });
        return staged ? { staged, threshold, contextTokens } : undefined;
      });
      if (!reserved)
        return;
      const started = await reserved.staged();
      if (started) {
        logger.info("Automatic compression initiated", {
          sessionId: info.sessionID,
          messageId: info.id,
          contextTokens: reserved.contextTokens,
          thresholdTokens: reserved.threshold.thresholdTokens,
          reason: reserved.threshold.reason
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Automatic compression failed to start", {
        sessionId: info.sessionID,
        messageId: info.id,
        error: message
      });
      const shown = await showToast(client, {
        title: "Automatic Compression",
        message: `Could not start automatic compression: ${message}`,
        variant: "error",
        duration: 8000
      });
      if (!shown) {
        await sendIgnoredMessage(client, info.sessionID, `Could not start automatic compression: ${message}`, {
          agent: info.agent,
          providerId: info.providerID,
          modelId: info.modelID,
          variant: state.variant
        }, logger);
      }
    } finally {
      if (attemptedStart) {
        state.autoCompressionStarting = false;
      }
    }
  };
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// lib/config.ts
import { readFileSync, writeFileSync, existsSync as existsSync2, mkdirSync, statSync } from "fs";
import { join as join2, dirname } from "path";
import { homedir as homedir2 } from "os";
import { parse } from "jsonc-parser";
var DEFAULT_AUTO_COMPRESSION = {
  enabled: true,
  contextWindowRatio: 0.9,
  tokenThreshold: 432000
};
function resolveProtectedTurnsSetting(layer, fallback = 3, hasExplicitTopLevel = false) {
  if (layer.protectedTurns !== undefined)
    return layer.protectedTurns;
  if (hasExplicitTopLevel)
    return fallback;
  return layer.autoCompression?.protectedTurns ?? fallback;
}
var VALID_CONFIG_KEYS = new Set([
  "$schema",
  "enabled",
  "debug",
  "dailyLog",
  "notification",
  "notificationType",
  "protectedTurns",
  "autoCompression",
  "autoCompression.enabled",
  "autoCompression.contextWindowRatio",
  "autoCompression.tokenThreshold",
  "autoCompression.protectedTurns",
  "commands",
  "commands.enabled",
  "tools",
  "tools.compress",
  "tools.compress.permission",
  "tools.compress.showCompression"
]);
function getConfigKeyPaths(obj, prefix = "") {
  const keys = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey);
    if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      keys.push(...getConfigKeyPaths(obj[key], fullKey));
    }
  }
  return keys;
}
function getInvalidConfigKeys(userConfig) {
  const userKeys = getConfigKeyPaths(userConfig);
  return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key));
}
function validateConfigTypes(config) {
  const errors = [];
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled });
  }
  if (config.debug !== undefined && typeof config.debug !== "boolean") {
    errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug });
  }
  if (config.dailyLog !== undefined && typeof config.dailyLog !== "boolean") {
    errors.push({ key: "dailyLog", expected: "boolean", actual: typeof config.dailyLog });
  }
  if (config.protectedTurns !== undefined && (typeof config.protectedTurns !== "number" || !Number.isInteger(config.protectedTurns) || config.protectedTurns < 0)) {
    errors.push({
      key: "protectedTurns",
      expected: "non-negative integer",
      actual: JSON.stringify(config.protectedTurns)
    });
  }
  if (config.notification !== undefined) {
    const validValues = ["off", "minimal", "detailed"];
    if (!validValues.includes(config.notification)) {
      errors.push({
        key: "notification",
        expected: '"off" | "minimal" | "detailed"',
        actual: JSON.stringify(config.notification)
      });
    }
  }
  if (config.notificationType !== undefined) {
    const validValues = ["chat", "toast"];
    if (!validValues.includes(config.notificationType)) {
      errors.push({
        key: "notificationType",
        expected: '"chat" | "toast"',
        actual: JSON.stringify(config.notificationType)
      });
    }
  }
  const autoCompression = config.autoCompression;
  if (autoCompression !== undefined) {
    if (!autoCompression || typeof autoCompression !== "object" || Array.isArray(autoCompression)) {
      errors.push({
        key: "autoCompression",
        expected: "object",
        actual: Array.isArray(autoCompression) ? "array" : typeof autoCompression
      });
    } else {
      if (autoCompression.enabled !== undefined && typeof autoCompression.enabled !== "boolean") {
        errors.push({
          key: "autoCompression.enabled",
          expected: "boolean",
          actual: typeof autoCompression.enabled
        });
      }
      if (autoCompression.contextWindowRatio !== undefined && (typeof autoCompression.contextWindowRatio !== "number" || autoCompression.contextWindowRatio <= 0 || autoCompression.contextWindowRatio > 1)) {
        errors.push({
          key: "autoCompression.contextWindowRatio",
          expected: "number greater than 0 and at most 1",
          actual: JSON.stringify(autoCompression.contextWindowRatio)
        });
      }
      if (autoCompression.tokenThreshold !== undefined && (typeof autoCompression.tokenThreshold !== "number" || !Number.isFinite(autoCompression.tokenThreshold) || autoCompression.tokenThreshold <= 0)) {
        errors.push({
          key: "autoCompression.tokenThreshold",
          expected: "positive finite number",
          actual: JSON.stringify(autoCompression.tokenThreshold)
        });
      }
      if (autoCompression.protectedTurns !== undefined && (typeof autoCompression.protectedTurns !== "number" || !Number.isInteger(autoCompression.protectedTurns) || autoCompression.protectedTurns < 0)) {
        errors.push({
          key: "autoCompression.protectedTurns",
          expected: "non-negative integer",
          actual: JSON.stringify(autoCompression.protectedTurns)
        });
      }
    }
  }
  const commands = config.commands;
  if (commands !== undefined) {
    if (typeof commands === "object") {
      if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
        errors.push({
          key: "commands.enabled",
          expected: "boolean",
          actual: typeof commands.enabled
        });
      }
    } else {
      errors.push({
        key: "commands",
        expected: "{ enabled: boolean }",
        actual: typeof commands
      });
    }
  }
  const tools = config.tools;
  if (tools) {
    if (tools.compress) {
      if (tools.compress.permission !== undefined) {
        const validValues = ["ask", "allow", "deny"];
        if (!validValues.includes(tools.compress.permission)) {
          errors.push({
            key: "tools.compress.permission",
            expected: '"ask" | "allow" | "deny"',
            actual: JSON.stringify(tools.compress.permission)
          });
        }
      }
      if (tools.compress.showCompression !== undefined && typeof tools.compress.showCompression !== "boolean") {
        errors.push({
          key: "tools.compress.showCompression",
          expected: "boolean",
          actual: typeof tools.compress.showCompression
        });
      }
    }
  }
  return errors;
}
function showConfigValidationWarnings(configPath, configData, isProject) {
  const invalidKeys = getInvalidConfigKeys(configData);
  const typeErrors = validateConfigTypes(configData);
  if (invalidKeys.length === 0 && typeErrors.length === 0) {
    return;
  }
  const configType = isProject ? "project config" : "config";
  const messages = [];
  if (invalidKeys.length > 0) {
    const keyList = invalidKeys.slice(0, 3).join(", ");
    const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : "";
    messages.push(`Unknown keys: ${keyList}${suffix}`);
  }
  if (typeErrors.length > 0) {
    for (const err of typeErrors.slice(0, 2)) {
      messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`);
    }
    if (typeErrors.length > 2) {
      messages.push(`(+${typeErrors.length - 2} more type errors)`);
    }
  }
  console.warn(`Context Compress: Invalid ${configType}
${configPath}
${messages.join(`
`)}`);
}
var defaultConfig = {
  enabled: true,
  debug: false,
  notification: "detailed",
  notificationType: "chat",
  protectedTurns: 3,
  commands: {
    enabled: true
  },
  autoCompression: { ...DEFAULT_AUTO_COMPRESSION },
  tools: {
    compress: {
      permission: "allow",
      showCompression: false
    }
  }
};
var GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME ? join2(process.env.XDG_CONFIG_HOME, "opencode") : join2(homedir2(), ".config", "opencode");
var GLOBAL_CONFIG_PATH_JSONC = join2(GLOBAL_CONFIG_DIR, "compress.jsonc");
var GLOBAL_CONFIG_PATH_JSON = join2(GLOBAL_CONFIG_DIR, "compress.json");
function findOpencodeDir(startDir) {
  let current = startDir;
  while (current !== "/") {
    const candidate = join2(current, ".opencode");
    if (existsSync2(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current)
      break;
    current = parent;
  }
  return null;
}
function getConfigPaths(ctx) {
  let globalPath = null;
  if (existsSync2(GLOBAL_CONFIG_PATH_JSONC)) {
    globalPath = GLOBAL_CONFIG_PATH_JSONC;
  } else if (existsSync2(GLOBAL_CONFIG_PATH_JSON)) {
    globalPath = GLOBAL_CONFIG_PATH_JSON;
  }
  let configDirPath = null;
  const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  if (opencodeConfigDir) {
    const configJsonc = join2(opencodeConfigDir, "compress.jsonc");
    const configJson = join2(opencodeConfigDir, "compress.json");
    if (existsSync2(configJsonc)) {
      configDirPath = configJsonc;
    } else if (existsSync2(configJson)) {
      configDirPath = configJson;
    }
  }
  let projectPath = null;
  if (ctx?.directory) {
    const opencodeDir = findOpencodeDir(ctx.directory);
    if (opencodeDir) {
      const projectJsonc = join2(opencodeDir, "compress.jsonc");
      const projectJson = join2(opencodeDir, "compress.json");
      if (existsSync2(projectJsonc)) {
        projectPath = projectJsonc;
      } else if (existsSync2(projectJson)) {
        projectPath = projectJson;
      }
    }
  }
  return { global: globalPath, configDir: configDirPath, project: projectPath };
}
function createDefaultConfig() {
  if (!existsSync2(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
  const configContent = `{
  "$schema": "compress.schema.json"
}
`;
  writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8");
}
function loadConfigFile(configPath) {
  let fileContent;
  try {
    fileContent = readFileSync(configPath, "utf-8");
  } catch {
    return { data: null };
  }
  try {
    const parsed = parse(fileContent);
    if (parsed === undefined || parsed === null) {
      return { data: null, parseError: "Config file is empty or invalid" };
    }
    return { data: parsed };
  } catch (error) {
    return { data: null, parseError: error.message || "Failed to parse config" };
  }
}
function mergeTools(base, override) {
  if (!override)
    return base;
  return {
    compress: {
      permission: override.compress?.permission ?? base.compress.permission,
      showCompression: override.compress?.showCompression ?? base.compress.showCompression
    }
  };
}
function mergeCommands(base, override) {
  if (override === undefined)
    return base;
  return {
    enabled: override.enabled ?? base.enabled
  };
}
function mergeAutoCompression(base, override) {
  if (override === undefined)
    return base;
  return {
    enabled: override.enabled ?? base.enabled,
    contextWindowRatio: override.contextWindowRatio ?? base.contextWindowRatio,
    tokenThreshold: override.tokenThreshold ?? base.tokenThreshold
  };
}
function deepCloneConfig(config) {
  return {
    ...config,
    commands: { ...config.commands },
    autoCompression: { ...config.autoCompression },
    tools: {
      compress: { ...config.tools.compress }
    }
  };
}
function getConfig(ctx) {
  let config = deepCloneConfig(defaultConfig);
  let hasExplicitProtectedTurns = false;
  const configPaths = getConfigPaths(ctx);
  if (configPaths.global) {
    const result = loadConfigFile(configPaths.global);
    if (result.parseError) {
      console.warn(`Context Compress: Invalid config
${configPaths.global}
${result.parseError}
Using default values`);
    } else if (result.data) {
      showConfigValidationWarnings(configPaths.global, result.data, false);
      config = {
        enabled: result.data.enabled ?? config.enabled,
        debug: result.data.debug ?? config.debug,
        dailyLog: result.data.dailyLog ?? config.dailyLog,
        notification: result.data.notification ?? config.notification,
        notificationType: result.data.notificationType ?? config.notificationType,
        protectedTurns: resolveProtectedTurnsSetting(result.data, config.protectedTurns, hasExplicitProtectedTurns),
        commands: mergeCommands(config.commands, result.data.commands),
        autoCompression: mergeAutoCompression(config.autoCompression, result.data.autoCompression),
        tools: mergeTools(config.tools, result.data.tools)
      };
      hasExplicitProtectedTurns = result.data.protectedTurns !== undefined;
    }
  } else {
    createDefaultConfig();
  }
  if (configPaths.configDir) {
    const result = loadConfigFile(configPaths.configDir);
    if (result.parseError) {
      console.warn(`Context Compress: Invalid configDir config
${configPaths.configDir}
${result.parseError}
Using global/default values`);
    } else if (result.data) {
      showConfigValidationWarnings(configPaths.configDir, result.data, true);
      config = {
        enabled: result.data.enabled ?? config.enabled,
        debug: result.data.debug ?? config.debug,
        dailyLog: result.data.dailyLog ?? config.dailyLog,
        notification: result.data.notification ?? config.notification,
        notificationType: result.data.notificationType ?? config.notificationType,
        protectedTurns: resolveProtectedTurnsSetting(result.data, config.protectedTurns, hasExplicitProtectedTurns),
        commands: mergeCommands(config.commands, result.data.commands),
        autoCompression: mergeAutoCompression(config.autoCompression, result.data.autoCompression),
        tools: mergeTools(config.tools, result.data.tools)
      };
      hasExplicitProtectedTurns = hasExplicitProtectedTurns || result.data.protectedTurns !== undefined;
    }
  }
  if (configPaths.project) {
    const result = loadConfigFile(configPaths.project);
    if (result.parseError) {
      console.warn(`Context Compress: Invalid project config
${configPaths.project}
${result.parseError}
Using global/default values`);
    } else if (result.data) {
      showConfigValidationWarnings(configPaths.project, result.data, true);
      config = {
        enabled: result.data.enabled ?? config.enabled,
        debug: result.data.debug ?? config.debug,
        dailyLog: result.data.dailyLog ?? config.dailyLog,
        notification: result.data.notification ?? config.notification,
        notificationType: result.data.notificationType ?? config.notificationType,
        protectedTurns: resolveProtectedTurnsSetting(result.data, config.protectedTurns, hasExplicitProtectedTurns),
        commands: mergeCommands(config.commands, result.data.commands),
        autoCompression: mergeAutoCompression(config.autoCompression, result.data.autoCompression),
        tools: mergeTools(config.tools, result.data.tools)
      };
      hasExplicitProtectedTurns = hasExplicitProtectedTurns || result.data.protectedTurns !== undefined;
    }
  }
  return config;
}

// lib/commands/auto.ts
var AUTO_USAGE = [
  "Usage: `/compress auto [status|on|off|threshold N|ratio N|reset]`",
  "`threshold N` requires a positive whole-token count; `ratio N` requires 1-99."
].join(`
`);
function formatRatioPercent(ratio) {
  return Number((ratio * 100).toFixed(6)).toString();
}
function parseAutoAction(args) {
  const action = args[0]?.toLowerCase() ?? "status";
  if (action === "status" && args.length <= 1)
    return { kind: "status" };
  if (action === "on" && args.length === 1)
    return { kind: "on" };
  if (action === "off" && args.length === 1)
    return { kind: "off" };
  if (action === "reset" && args.length === 1)
    return { kind: "reset" };
  if (action === "threshold" && args.length === 2 && /^[0-9]+$/.test(args[1])) {
    const value = Number(args[1]);
    if (Number.isSafeInteger(value) && value > 0) {
      return { kind: "threshold", value };
    }
  }
  if (action === "ratio" && args.length === 2 && /^[0-9]+$/.test(args[1])) {
    const value = Number(args[1]);
    if (Number.isInteger(value) && value >= 1 && value <= 99) {
      return { kind: "ratio", value };
    }
  }
  return { kind: "invalid" };
}
function formatStatus(config, state, messages) {
  const policy = resolveEffectiveAutoCompressionPolicy(config.autoCompression, state);
  const remaining = getPostCompressionCooldownRemaining(state, messages);
  const globalAvailability = policy.globallyEnabled ? "enabled" : "disabled by config; session commands cannot enable it";
  return [
    "**Automatic compression (this session)**",
    `- Global availability: ${globalAvailability}`,
    `- Effective state: ${policy.enabled ? "on" : "off"} (${policy.enabledSource})`,
    `- Token threshold: ${policy.tokenThreshold.toLocaleString("en-US")} tokens (${policy.tokenThresholdSource})`,
    `- Context ratio: ${formatRatioPercent(policy.contextWindowRatio)}% (${policy.contextWindowRatioSource})`,
    `- Cooldown: ${remaining} assistant ${remaining === 1 ? "response" : "responses"} remaining`
  ].join(`
`);
}
async function handleAutoCommand(ctx) {
  const action = parseAutoAction(ctx.arguments);
  let response;
  if (action.kind === "invalid") {
    response = AUTO_USAGE;
  } else {
    response = await ctx.stateManager.runExclusive(ctx.sessionId, async () => {
      const messages = await listSessionMessages(ctx.client, ctx.sessionId);
      await reconcileSessionLifecycle(ctx.state, ctx.sessionId, ctx.logger, messages);
      if (!ctx.state.persistenceSynchronized) {
        return "Automatic compression settings are unavailable because saved session state could not be loaded. No session setting was changed.";
      }
      if (action.kind === "status") {
        return formatStatus(ctx.config, ctx.state, messages);
      }
      const effectivePolicy = resolveEffectiveAutoCompressionPolicy(ctx.config.autoCompression, ctx.state);
      if (action.kind === "on" && effectivePolicy.enabled) {
        return `Automatic compression is already on (${effectivePolicy.enabledSource}). No session setting was changed.`;
      }
      if (action.kind === "off" && !effectivePolicy.enabled) {
        const source = effectivePolicy.globallyEnabled ? effectivePolicy.enabledSource : "global config";
        return `Automatic compression is already off (${source}). No session setting was changed.`;
      }
      if (!ctx.config.autoCompression.enabled) {
        return "Automatic compression is disabled globally. Session overrides cannot turn it on.";
      }
      const candidate = { ...ctx.state };
      let successMessage;
      switch (action.kind) {
        case "on":
          candidate.autoCompressionEnabledOverride = true;
          successMessage = "Automatic compression is on for this session.";
          break;
        case "off":
          candidate.autoCompressionEnabledOverride = false;
          successMessage = "Automatic compression is off for this session. Both absolute and ratio triggers are disabled.";
          break;
        case "threshold":
          candidate.autoCompressionTokenThresholdOverride = action.value;
          successMessage = `Automatic compression threshold set to ${action.value.toLocaleString("en-US")} tokens for this session.`;
          break;
        case "ratio":
          candidate.autoCompressionContextWindowRatioOverride = action.value / 100;
          successMessage = `Automatic compression ratio set to ${action.value}% for this session.`;
          break;
        case "reset":
          candidate.autoCompressionTokenThresholdOverride = undefined;
          candidate.autoCompressionContextWindowRatioOverride = undefined;
          successMessage = `Defaults reset to ${ctx.config.autoCompression.tokenThreshold.toLocaleString("en-US")} tokens and ${formatRatioPercent(ctx.config.autoCompression.contextWindowRatio)}% threshold.`;
          break;
      }
      const persisted = await saveSessionState(candidate, ctx.logger);
      if (!persisted) {
        return "Automatic compression settings could not be saved. No session setting was changed.";
      }
      commitDurableSessionState(ctx.state, candidate);
      return successMessage;
    });
  }
  const params = getCurrentParams(ctx.state, ctx.messages, ctx.logger);
  await sendIgnoredMessage(ctx.client, ctx.sessionId, response, params, ctx.logger);
}

// lib/commands/context.ts
function analyzeTokens(state, messages, providerId) {
  const breakdown = {
    system: 0,
    user: 0,
    assistant: 0,
    tools: 0,
    toolCount: 0,
    compressedTokens: state.stats.totalCompressTokens,
    compressedToolCount: state.compressed.toolIds.size,
    compressedMessageCount: state.compressed.messageIds.size,
    total: 0
  };
  let firstAssistant;
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      const assistantInfo = msg.info;
      if ((assistantInfo.tokens?.input ?? 0) > 0 || (assistantInfo.tokens?.cache?.read ?? 0) > 0) {
        firstAssistant = assistantInfo;
        break;
      }
    }
  }
  let lastAssistant;
  for (let i = messages.length - 1;i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "assistant") {
      const assistantInfo = msg.info;
      if ((assistantInfo.tokens?.output ?? 0) > 0) {
        lastAssistant = assistantInfo;
        break;
      }
    }
  }
  const apiInput = lastAssistant?.tokens?.input || 0;
  const apiOutput = lastAssistant?.tokens?.output || 0;
  const apiReasoning = lastAssistant?.tokens?.reasoning || 0;
  const apiCacheRead = lastAssistant?.tokens?.cache?.read || 0;
  const apiCacheWrite = lastAssistant?.tokens?.cache?.write || 0;
  breakdown.total = apiInput + apiOutput + apiReasoning + apiCacheRead + apiCacheWrite;
  const userTextParts = [];
  const toolInputParts = [];
  const toolOutputParts = [];
  let firstUserText = "";
  let foundFirstUser = false;
  const foundToolIds = new Set;
  for (const msg of messages) {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const isCompacted = isMessageCompacted(state, msg);
    const isIgnoredUser = msg.info.role === "user" && isIgnoredUserMessage(msg);
    for (const part of parts) {
      if (part.type === "tool") {
        const toolPart = part;
        if (toolPart.callID && !foundToolIds.has(toolPart.callID)) {
          breakdown.toolCount++;
          foundToolIds.add(toolPart.callID);
        }
        const isCompressed = toolPart.callID && state.compressed.toolIds.has(toolPart.callID);
        if (!isCompacted && !isCompressed) {
          if (toolPart.state?.input) {
            const inputStr = typeof toolPart.state.input === "string" ? toolPart.state.input : JSON.stringify(toolPart.state.input);
            toolInputParts.push(inputStr);
          }
          if (toolPart.state?.status === "completed" && toolPart.state?.output) {
            const outputStr = typeof toolPart.state.output === "string" ? toolPart.state.output : JSON.stringify(toolPart.state.output);
            toolOutputParts.push(outputStr);
          }
        }
      } else if (part.type === "text" && msg.info.role === "user" && !isCompacted && !isIgnoredUser) {
        const textPart = part;
        const text = textPart.text || "";
        userTextParts.push(text);
        if (!foundFirstUser) {
          firstUserText += text;
        }
      }
    }
    if (msg.info.role === "user" && !isIgnoredUser && !foundFirstUser) {
      foundFirstUser = true;
    }
  }
  const firstUserTokens = countTokens(firstUserText, providerId);
  breakdown.user = countTokens(userTextParts.join(`
`), providerId);
  const toolInputTokens = countTokens(toolInputParts.join(`
`), providerId);
  const toolOutputTokens = countTokens(toolOutputParts.join(`
`), providerId);
  if (firstAssistant) {
    const firstInput = (firstAssistant.tokens?.input || 0) + (firstAssistant.tokens?.cache?.read || 0);
    breakdown.system = Math.max(0, firstInput - firstUserTokens);
  }
  breakdown.tools = toolInputTokens + toolOutputTokens;
  breakdown.assistant = Math.max(0, breakdown.total - breakdown.system - breakdown.user - breakdown.tools);
  return breakdown;
}
function createBar(value, maxValue, width, char = "\u2588") {
  if (maxValue === 0)
    return "";
  const filled = Math.round(value / maxValue * width);
  const bar = char.repeat(Math.max(0, filled));
  return bar;
}
function formatContextMessage(breakdown) {
  const lines = [];
  const barWidth = 30;
  const toolsInContext = breakdown.toolCount - breakdown.compressedToolCount;
  const toolsLabel = `Tools (${toolsInContext})`;
  const categories = [
    { label: "System", value: breakdown.system, char: "\u2588" },
    { label: "User", value: breakdown.user, char: "\u2593" },
    { label: "Assistant", value: breakdown.assistant, char: "\u2592" },
    { label: toolsLabel, value: breakdown.tools, char: "\u2591" }
  ];
  const maxLabelLen = Math.max(...categories.map((c) => c.label.length));
  lines.push("\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E");
  lines.push("\u2502               Compress Context Analysis                   \u2502");
  lines.push("\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F");
  lines.push("");
  lines.push("Session Context Breakdown:");
  lines.push("\u2500".repeat(60));
  lines.push("");
  for (const cat of categories) {
    const bar = createBar(cat.value, breakdown.total, barWidth, cat.char);
    const percentage = breakdown.total > 0 ? (cat.value / breakdown.total * 100).toFixed(1) : "0.0";
    const labelWithPct = `${cat.label.padEnd(maxLabelLen)} ${percentage.padStart(5)}% `;
    const valueStr = formatTokenCount(cat.value).padStart(13);
    lines.push(`${labelWithPct}\u2502${bar.padEnd(barWidth)}\u2502${valueStr}`);
  }
  lines.push("");
  lines.push("\u2500".repeat(60));
  lines.push("");
  lines.push("Summary:");
  if (breakdown.compressedTokens > 0) {
    const withoutCompression = breakdown.total + breakdown.compressedTokens;
    const compressed = [];
    if (breakdown.compressedToolCount > 0) {
      compressed.push(`${breakdown.compressedToolCount} tools`);
    }
    if (breakdown.compressedMessageCount > 0) {
      compressed.push(`${breakdown.compressedMessageCount} messages`);
    }
    lines.push(`  Compressed:      ${compressed.join(", ")} (~${formatTokenCount(breakdown.compressedTokens)})`);
    lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`);
    lines.push(`  Without plugin:  ~${formatTokenCount(withoutCompression)}`);
  } else {
    lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`);
  }
  lines.push("");
  return lines.join(`
`);
}
async function handleContextCommand(ctx) {
  const { client, state, logger, sessionId, messages } = ctx;
  const params = getCurrentParams(state, messages, logger);
  const breakdown = analyzeTokens(state, messages, params.providerId);
  const message = formatContextMessage(breakdown);
  await sendIgnoredMessage(client, sessionId, message, params, logger);
}

// lib/commands/help.ts
function formatHelpMessage() {
  const lines = [];
  lines.push("**Compress commands**");
  lines.push("");
  lines.push("- `/compress context` \u2014 Show token usage breakdown for current session");
  lines.push("- `/compress stats` \u2014 Show context compression statistics");
  lines.push("- `/compress manage [instruction]` \u2014 Manage context now, optionally with specific compression guidance");
  lines.push("- `/compress squash [instruction]` \u2014 Replace one agent-selected range of existing compressed blocks");
  lines.push("- `/compress auto [status|on|off|threshold N|ratio N|reset]` \u2014 Control automatic compression for this session");
  lines.push("- `/compress help` \u2014 Show this command list");
  lines.push("");
  lines.push("Session `auto off` disables all automatic compression, including both absolute and ratio triggers, until you turn it back on.");
  return lines.join(`
`);
}
async function handleHelpCommand(ctx) {
  const { client, state, logger, sessionId, messages } = ctx;
  const message = formatHelpMessage();
  const params = getCurrentParams(state, messages, logger);
  await sendIgnoredMessage(client, sessionId, message, params, logger);
  logger.info("Help command executed");
}

// lib/commands/squash.ts
function extractSquashCommandResidual(args) {
  const residual = (args || "").replace(/^\s*squash\b/i, "").replace(/^[\s:;,.|\-]+/, "").trim();
  return residual || undefined;
}
async function handleSquashCommand(ctx) {
  const currentParams = getCurrentParams(ctx.state, ctx.messages, ctx.logger);
  if (ctx.config.tools.compress.permission === "deny") {
    await sendManageFailureFeedback(ctx.client, ctx.logger, ctx.sessionId, "Block squash did not start because squash follows the denied compress permission. Enable the compression tool, then run `/compress squash` again.", currentParams);
    return;
  }
  const staged = await ctx.stateManager.runExclusive(ctx.sessionId, async () => {
    if (!ctx.state.persistenceSynchronized) {
      return async () => {
        await sendManageFailureFeedback(ctx.client, ctx.logger, ctx.sessionId, "Block squash could not start because saved session state could not be loaded.", currentParams);
        return false;
      };
    }
    const active = findActiveManagementTurn(ctx.state, ctx.messages);
    if (active && active.turn.source !== "squash") {
      return async () => {
        await sendManageFailureFeedback(ctx.client, ctx.logger, ctx.sessionId, "Block squash could not start because a compression management turn is still active.", currentParams);
        return false;
      };
    }
    let blockCount;
    try {
      blockCount = orderCompressBlocks(ctx.messages, ctx.state.compressSummaries).length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return async () => {
        await sendManageFailureFeedback(ctx.client, ctx.logger, ctx.sessionId, `Block squash could not start: ${message}`, currentParams);
        return false;
      };
    }
    if (blockCount < 2) {
      return async () => {
        await sendManageFailureFeedback(ctx.client, ctx.logger, ctx.sessionId, "Block squash requires at least two existing compressed blocks.", currentParams);
        return false;
      };
    }
    return stageManagementTurnWithinLock({
      ...ctx,
      systemPrompt: renderSquashSystemPrompt(),
      retainedText: extractSquashCommandResidual(ctx.arguments),
      source: "squash"
    });
  });
  if (staged)
    await staged();
}

// lib/commands/stats.ts
function formatStatsMessage(sessionTokens, sessionTools, sessionMessages, allTime) {
  const lines = [];
  lines.push("**Compress statistics**");
  lines.push("");
  lines.push("**Session**");
  lines.push(`- Tokens saved: ~${formatTokenCount(sessionTokens)}`);
  lines.push(`- Tools compressed: ${sessionTools}`);
  lines.push(`- Messages compressed: ${sessionMessages}`);
  lines.push("");
  lines.push("**All-time**");
  lines.push(`- Tokens saved: ~${formatTokenCount(allTime.totalTokens)}`);
  lines.push(`- Tools compressed: ${allTime.totalTools}`);
  lines.push(`- Messages compressed: ${allTime.totalMessages}`);
  lines.push(`- Sessions: ${allTime.sessionCount}`);
  return lines.join(`
`);
}
async function handleStatsCommand(ctx) {
  const { client, state, logger, sessionId, messages } = ctx;
  const sessionTokens = state.stats.totalCompressTokens;
  const sessionTools = state.compressed.toolIds.size;
  const sessionMessages = state.compressed.messageIds.size;
  const allTime = await loadAllSessionStats(logger);
  const message = formatStatsMessage(sessionTokens, sessionTools, sessionMessages, allTime);
  const params = getCurrentParams(state, messages, logger);
  await sendIgnoredMessage(client, sessionId, message, params, logger);
  logger.info("Stats command executed", {
    sessionTokens,
    sessionTools,
    sessionMessages,
    allTimeTokens: allTime.totalTokens,
    allTimeTools: allTime.totalTools,
    allTimeMessages: allTime.totalMessages
  });
}

// lib/commands/route.ts
async function handleCompressCommand(input, dependencies) {
  if (!dependencies.config.commands.enabled || input.command !== "compress")
    return false;
  const { client, stateManager, logger, config } = dependencies;
  const state = stateManager.get(input.sessionID);
  const messages = await stateManager.runExclusive(input.sessionID, async () => {
    const currentMessages = await listSessionMessages(client, input.sessionID);
    await reconcileSessionLifecycle(state, input.sessionID, logger, currentMessages);
    return currentMessages;
  });
  const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean);
  const subcommand = args[0]?.toLowerCase() || "";
  if (subcommand === "context") {
    await handleContextCommand({ client, state, logger, sessionId: input.sessionID, messages });
    return true;
  }
  if (subcommand === "stats") {
    await handleStatsCommand({ client, state, logger, sessionId: input.sessionID, messages });
    return true;
  }
  if (subcommand === "manage") {
    await handleManageCommand({
      client,
      stateManager,
      state,
      config,
      logger,
      sessionId: input.sessionID,
      messages,
      arguments: input.arguments
    });
    return true;
  }
  if (subcommand === "squash") {
    await handleSquashCommand({
      client,
      stateManager,
      state,
      config,
      logger,
      sessionId: input.sessionID,
      messages,
      arguments: input.arguments
    });
    return true;
  }
  if (subcommand === "auto") {
    await handleAutoCommand({
      client,
      stateManager,
      state,
      config,
      logger,
      sessionId: input.sessionID,
      messages,
      arguments: args.slice(1)
    });
    return true;
  }
  await handleHelpCommand({ client, state, logger, sessionId: input.sessionID, messages });
  return true;
}

// lib/logger.ts
import { writeFile, mkdir as mkdir2 } from "fs/promises";
import { join as join3 } from "path";
import { existsSync as existsSync3 } from "fs";
import { homedir as homedir3 } from "os";
class Logger {
  logDir;
  dailyEnabled;
  contextEnabled;
  constructor(options) {
    this.dailyEnabled = options.daily;
    this.contextEnabled = options.context;
    const configHome = process.env.XDG_CONFIG_HOME || join3(homedir3(), ".config");
    this.logDir = join3(configHome, "opencode", "logs", "compress");
  }
  async ensureLogDir() {
    if (!existsSync3(this.logDir)) {
      await mkdir2(this.logDir, { recursive: true });
    }
  }
  formatData(data) {
    if (!data)
      return "";
    const parts = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null)
        continue;
      if (Array.isArray(value)) {
        if (value.length === 0)
          continue;
        parts.push(`${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`);
      } else if (typeof value === "object") {
        const str = JSON.stringify(value);
        if (str.length < 50) {
          parts.push(`${key}=${str}`);
        }
      } else {
        parts.push(`${key}=${value}`);
      }
    }
    return parts.join(" ");
  }
  getCallerFile(skipFrames = 3) {
    const originalPrepareStackTrace = Error.prepareStackTrace;
    try {
      const err = new Error;
      Error.prepareStackTrace = (_, stack) => stack;
      const stack = err.stack;
      Error.prepareStackTrace = originalPrepareStackTrace;
      for (let i = skipFrames;i < stack.length; i++) {
        const filename = stack[i]?.getFileName();
        if (filename && !filename.includes("/logger.")) {
          const match = filename.match(/([^/\\]+)\.[tj]s$/);
          return match ? match[1] : filename;
        }
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }
  async write(level, component, message, data) {
    if (!this.dailyEnabled)
      return;
    try {
      await this.ensureLogDir();
      const timestamp = new Date().toISOString();
      const dataStr = this.formatData(data);
      const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? " | " + dataStr : ""}
`;
      const dailyLogDir = join3(this.logDir, "daily");
      if (!existsSync3(dailyLogDir)) {
        await mkdir2(dailyLogDir, { recursive: true });
      }
      const logFile = join3(dailyLogDir, `${new Date().toISOString().split("T")[0]}.log`);
      await writeFile(logFile, logLine, { flag: "a" });
    } catch (error) {
      console.error("context-compress: failed to write daily log", error);
    }
  }
  info(message, data) {
    const component = this.getCallerFile(2);
    return this.write("INFO", component, message, data);
  }
  debug(message, data) {
    const component = this.getCallerFile(2);
    return this.write("DEBUG", component, message, data);
  }
  warn(message, data) {
    const component = this.getCallerFile(2);
    return this.write("WARN", component, message, data);
  }
  error(message, data) {
    const component = this.getCallerFile(2);
    return this.write("ERROR", component, message, data);
  }
  minimizeForDebug(messages) {
    return messages.map((msg) => {
      const minimized = {
        role: msg.info?.role ?? msg.role
      };
      if (msg.info?.time?.created) {
        minimized.time = msg.info.time.created;
      }
      if (msg.info?.tokens) {
        minimized.tokens = {
          input: msg.info.tokens.input,
          output: msg.info.tokens.output,
          reasoning: msg.info.tokens.reasoning,
          cache: msg.info.tokens.cache
        };
      }
      const parts = msg.parts ?? msg.content;
      if (parts) {
        minimized.parts = parts.map((part) => {
          if (part.type === "step-start" || part.type === "step-finish") {
            return null;
          }
          if (part.type === "text") {
            if (part.ignored)
              return null;
            return { type: "text", text: part.text };
          }
          if (part.type === "reasoning") {
            return {
              type: "reasoning",
              text: part.text
            };
          }
          if (part.type === "tool") {
            const toolPart = {
              type: "tool",
              tool: part.tool,
              callID: part.callID
            };
            if (part.state?.status) {
              toolPart.status = part.state.status;
            }
            if (part.state?.input) {
              toolPart.input = part.state.input;
            }
            if (part.state?.output) {
              toolPart.output = part.state.output;
            }
            if (part.state?.error) {
              toolPart.error = part.state.error;
            }
            return toolPart;
          }
          if (part.type === "tool-call") {
            return {
              type: "tool-call",
              tool: part.name,
              callID: part.id,
              input: part.input
            };
          }
          if (part.type === "tool-result") {
            return {
              type: "tool-result",
              tool: part.name,
              callID: part.id,
              output: part.result
            };
          }
          return null;
        }).filter(Boolean);
      }
      return minimized;
    });
  }
  async saveContext(sessionId, messages) {
    if (!this.contextEnabled)
      return;
    try {
      const contextDir = join3(this.logDir, "context", sessionId);
      if (!existsSync3(contextDir)) {
        await mkdir2(contextDir, { recursive: true });
      }
      const minimized = this.minimizeForDebug(messages);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const contextFile = join3(contextDir, `${timestamp}.json`);
      await writeFile(contextFile, JSON.stringify(minimized, null, 2));
    } catch (error) {
      console.error("context-compress: failed to write context snapshot", error);
    }
  }
}

// lib/messages/post-compression-notice.ts
function isAgentWorkPart(part) {
  if (!part || typeof part !== "object")
    return false;
  const value = part;
  if (value.type === "tool")
    return true;
  return value.type === "text" && typeof value.text === "string" && value.text.trim().length > 0;
}
function isResumableAgentTurn(info) {
  return info.summary !== true && !info.error;
}
function isPostCompressionNoticeDue(state, rawMessages) {
  const anchorMessageId = state.compressionCooldownAfterMessageId;
  if (!anchorMessageId)
    return false;
  const anchorIndex = rawMessages.findIndex((message) => message.info.id === anchorMessageId);
  if (anchorIndex === -1)
    return false;
  const anchor = rawMessages[anchorIndex];
  if (isResumableAgentTurn(anchor.info)) {
    const anchorParts = anchor.parts ?? [];
    let compressPartIndex = -1;
    for (let i = anchorParts.length - 1;i >= 0; i--) {
      const part = anchorParts[i];
      if (part?.type === "tool" && part.tool === "compress") {
        compressPartIndex = i;
        break;
      }
    }
    const tailStart = compressPartIndex === -1 ? anchorParts.length : compressPartIndex + 1;
    for (let i = tailStart;i < anchorParts.length; i++) {
      if (isAgentWorkPart(anchorParts[i]))
        return false;
    }
  }
  for (let i = anchorIndex + 1;i < rawMessages.length; i++) {
    const message = rawMessages[i];
    if (message.info.role !== "assistant")
      continue;
    if (!isResumableAgentTurn(message.info))
      continue;
    if ((message.parts ?? []).some(isAgentWorkPart))
      return false;
  }
  return true;
}

// lib/messages/v2-transform.ts
function transformV2Messages(raw, state, logger, modelMessages) {
  const projected = new Map(raw.map((message) => [message.info.id, message]));
  const tools = new Map;
  for (const message of raw) {
    for (const part of message.parts) {
      if (part.type !== "tool")
        continue;
      if (tools.has(part.callID))
        throw new Error(`Duplicate projected tool call ID: ${part.callID}`);
      tools.set(part.callID, message.info.id);
    }
  }
  const owned = new Map;
  const passthrough = [];
  const system = raw.filter((message) => message.info.sourceType === "system");
  const usedSystem = new Set;
  for (const message of modelMessages) {
    if (message.id === undefined && message.role === "assistant" && message.content.every((part) => part.type === "text" || part.type === "reasoning")) {
      passthrough.push(message);
      continue;
    }
    const owner = resolveOwner(message, projected, tools, system, usedSystem);
    if (!owner) {
      passthrough.push(message);
      continue;
    }
    const current = owned.get(owner) ?? [];
    current.push(message);
    owned.set(owner, current);
  }
  const transformed = structuredClone(raw);
  applyCompressTransforms(state, logger, transformed);
  return [
    ...transformed.flatMap((message) => {
      if (message.info.role === "user" && isIgnoredUserMessage(message))
        return [];
      if (!projected.has(message.info.id))
        return [summaryMessage(message)];
      const source = projected.get(message.info.id);
      if (!source)
        throw new Error(`Missing projected source for ${message.info.id}`);
      const messages = owned.get(message.info.id) ?? [];
      if (messages.length === 0)
        return [];
      if (message.info.role === "assistant")
        return transformToolPair(messages, message, state);
      if (message.info.role === "user" && text(message) !== text(source)) {
        return messages.map((item) => ({ ...item, content: [{ type: "text", text: text(message) }] }));
      }
      return messages;
    }),
    ...passthrough
  ];
}
function resolveOwner(message, projected, tools, system, usedSystem) {
  if (message.id && projected.has(message.id))
    return message.id;
  const resultOwners = new Set(message.content.filter((part) => part.type === "tool-result" && typeof part.id === "string").map((part) => tools.get(part.id)).filter((owner) => owner !== undefined));
  if (resultOwners.size === 1 && message.content.every((part) => part.type === "tool-result")) {
    return [...resultOwners][0];
  }
  if (message.role === "system") {
    const content = textFromModel(message);
    const match = system.find((candidate) => !usedSystem.has(candidate.info.id) && text(candidate) === content);
    if (match) {
      usedSystem.add(match.info.id);
      return match.info.id;
    }
  }
  if (message.id === undefined && (message.role === "user" || message.role === "system"))
    return;
  throw new Error(`Could not map a model-facing ${message.role} message to authoritative projected history`);
}
function transformToolPair(messages, target, state) {
  const tools = new Map(target.parts.filter((part) => part.type === "tool").map((part) => [part.callID, part]));
  return messages.flatMap((message) => {
    const content = message.content.flatMap((part) => {
      if (part.type !== "tool-call" && part.type !== "tool-result" || typeof part.id !== "string")
        return [part];
      const tool = tools.get(part.id);
      if (!tool)
        return [];
      if (part.type === "tool-call" && typeof tool.state.input !== "string") {
        return [{ ...part, input: structuredClone(tool.state.input) }];
      }
      if (part.type === "tool-result" && state.compressed.toolIds.has(tool.callID) && tool.state.status === "completed" && tool.tool !== "question" && tool.tool !== "edit" && tool.tool !== "write") {
        return [{ ...part, result: { type: "text", value: String(tool.state.output ?? "") } }];
      }
      return [part];
    });
    if (content.length === 0)
      return [];
    return [{ ...message, content }];
  });
}
function summaryMessage(message) {
  return {
    id: message.info.id,
    role: "user",
    content: [{ type: "text", text: text(message) }]
  };
}
function text(message) {
  return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join(`
`);
}
function textFromModel(message) {
  return message.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join(`
`);
}

// lib/state/fork.ts
async function inheritForkCompression(session, client, state, logger, childMessages) {
  if (!state.sessionId || state.hasPersistedState)
    return;
  const child = await session.get({ sessionID: state.sessionId });
  if (!child.fork)
    return;
  const parentMessages = await listSessionMessages(client, child.fork.sessionID);
  const parentState = await loadSessionState(child.fork.sessionID, logger, parentMessages);
  if (parentState.status === "error")
    throw new Error("Cannot read parent compression state for fork");
  if (parentState.status === "missing")
    return;
  const boundary = parentMessages.findIndex((message) => message.info.id === child.fork?.boundary.messageID);
  if (boundary < 0)
    throw new Error("Fork boundary is outside the parent context");
  const parentPrefix = parentMessages.slice(0, child.fork.boundary.type === "before" ? boundary : boundary + 1).filter((message) => {
    if (message.info.sourceType === "assistant")
      return message.info.time.completed !== undefined;
    if (message.info.sourceType === "shell")
      return message.info.finish === "stop";
    if (message.info.sourceType === "compaction") {
      return message.info.time.completed !== undefined || message.info.error !== undefined;
    }
    return true;
  });
  if (childMessages.length < parentPrefix.length) {
    throw new Error("Fork transcript is shorter than its copied parent history");
  }
  const mapped = new Map;
  for (let index = 0;index < parentPrefix.length; index++) {
    const parent = parentPrefix[index];
    const forked = childMessages[index];
    if (parent.info.sourceType !== forked.info.sourceType || parent.info.time.created !== forked.info.time.created || JSON.stringify(parent.parts) !== JSON.stringify(forked.parts))
      throw new Error("Fork transcript differs from the copied parent history");
    mapped.set(parent.info.id, forked.info.id);
  }
  const messageID = (id) => {
    const result = mapped.get(id);
    if (!result)
      throw new Error(`Compression state references a message outside the fork: ${id}`);
    return result;
  };
  const summaries = parentState.state.compressSummaries.filter((summary) => {
    const anchor = parentMessages.findIndex((message) => message.info.id === summary.anchorMessageId);
    if (anchor < 0)
      throw new Error("Parent compression block has no transcript anchor");
    if (anchor > boundary || anchor === boundary && child.fork?.boundary.type === "before")
      return false;
    if (!mapped.has(summary.anchorMessageId))
      throw new Error("Fork did not copy a compression block anchor");
    return summary.messageIds.every((id) => mapped.has(id));
  });
  const turns = parentState.state.managementTurns.filter((turn) => {
    if (!mapped.has(turn.triggerMessageId))
      return false;
    return [turn.triggeredByMessageId, turn.completedMessageId, ...turn.protectedMessageIds ?? []].every((id) => !id || mapped.has(id));
  });
  const compressedMessages = new Set(summaries.flatMap((summary) => summary.messageIds.map(messageID)));
  const childTools = new Set(childMessages.slice(0, parentPrefix.length).filter((message) => compressedMessages.has(message.info.id)).flatMap((message) => message.parts.flatMap((part) => part.type === "tool" ? [part.callID] : [])));
  const candidate = {
    ...state,
    compressed: {
      messageIds: new Set(parentState.state.compressed.messageIds.filter((id) => mapped.has(id) && compressedMessages.has(messageID(id))).map(messageID)),
      toolIds: new Set(parentState.state.compressed.toolIds.filter((id) => childTools.has(id)))
    },
    compressSummaries: summaries.map((summary) => ({
      ...summary,
      anchorMessageId: messageID(summary.anchorMessageId),
      messageIds: summary.messageIds.map(messageID)
    })),
    managementTurns: turns.map((turn) => ({
      ...turn,
      triggerMessageId: messageID(turn.triggerMessageId),
      ...turn.triggeredByMessageId ? { triggeredByMessageId: messageID(turn.triggeredByMessageId) } : {},
      ...turn.completedMessageId ? { completedMessageId: messageID(turn.completedMessageId) } : {},
      ...turn.protectedMessageIds ? { protectedMessageIds: turn.protectedMessageIds.map(messageID) } : {}
    })),
    stats: { ...parentState.state.stats },
    autoCompressionEnabledOverride: parentState.state.autoCompressionEnabledOverride,
    autoCompressionTokenThresholdOverride: parentState.state.autoCompressionTokenThresholdOverride,
    autoCompressionContextWindowRatioOverride: parentState.state.autoCompressionContextWindowRatioOverride,
    compressionCooldownAfterMessageId: parentState.state.compressionCooldownAfterMessageId && mapped.has(parentState.state.compressionCooldownAfterMessageId) ? messageID(parentState.state.compressionCooldownAfterMessageId) : undefined,
    lastCompaction: parentState.state.lastCompaction ?? 0
  };
  if (!await saveSessionState(candidate, logger))
    throw new Error("Cannot persist fork compression state");
}

// lib/tools/utils.ts
function getCompletedToolOutputText(part, output, options) {
  if (part.tool === "image_generation") {
    const callId = typeof part.callID === "string" && part.callID.length > 0 ? part.callID.length > 56 ? `${part.callID.slice(0, 53)}...` : part.callID : undefined;
    return typeof part.callID === "string" && part.callID.length > 0 ? `[generated image: ${callId}]` : "[generated image]";
  }
  if (options?.requireTruthy ? !output : output === undefined || output === null) {
    return;
  }
  if (typeof output === "string") {
    return output;
  }
  if (options?.stringifyNonString) {
    return JSON.stringify(output);
  }
  return;
}
function collectToolIdsInRange(messages, startIndex, endIndex) {
  const toolIds = [];
  for (let i = startIndex;i <= endIndex; i++) {
    const msg = messages[i];
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part.type === "tool" && part.callID) {
        if (!toolIds.includes(part.callID)) {
          toolIds.push(part.callID);
        }
      }
    }
  }
  return toolIds;
}
function collectContentInRange(messages, startIndex, endIndex) {
  const contents = [];
  for (let i = startIndex;i <= endIndex; i++) {
    const msg = messages[i];
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part.type === "text") {
        contents.push(part.text);
      } else if (part.type === "tool") {
        const toolState = part.state;
        if (toolState?.input) {
          contents.push(typeof toolState.input === "string" ? toolState.input : JSON.stringify(toolState.input));
        }
        if (toolState?.status === "completed") {
          const output = getCompletedToolOutputText(part, toolState.output, {
            requireTruthy: true,
            stringifyNonString: true
          });
          if (typeof output === "string") {
            contents.push(output);
          }
        } else if (toolState?.status === "error" && toolState?.error) {
          contents.push(typeof toolState.error === "string" ? toolState.error : JSON.stringify(toolState.error));
        }
      }
    }
  }
  return contents;
}

// lib/tools/compress.ts
var COMPRESS_TOOL_DESCRIPTION = loadPrompt("compress-tool-spec");
function isVisibleUserMessage3(message) {
  return message.info.role === "user" && message.info.sourceType !== "synthetic" && !isIgnoredUserMessage(message);
}
function findExecutingToolMessage(rawMessages, messageId, callId) {
  const matches = rawMessages.map((message, index) => ({ message, index })).filter(({ message }) => message.info.id === messageId);
  if (matches.length !== 1 || matches[0].message.info.role !== "assistant")
    return;
  const hasExecutingCall = matches[0].message.parts.some((part) => part.type === "tool" && part.tool === "compress" && (!callId || part.callID === callId));
  return hasExecutingCall ? matches[0] : undefined;
}
function resolveCompressionBoundary(rawMessages, state, toolMessageId, callId) {
  const activeTurn = findActiveManagementTurn(state, rawMessages);
  if (activeTurn) {
    if (activeTurn.turn.source === "squash") {
      throw new Error("compress cannot complete an active `/compress squash` turn. Call squash with one block range instead. Nothing was compressed.");
    }
    return {
      history: rawMessages.slice(0, activeTurn.triggerIndex),
      managementTurn: activeTurn.turn
    };
  }
  const executing = findExecutingToolMessage(rawMessages, toolMessageId, callId);
  if (!executing) {
    throw new Error("compress could not identify the executing tool call in the current session. Nothing was compressed.");
  }
  const parentId = executing.message.info.parentID;
  if (typeof parentId !== "string" || parentId.length === 0) {
    throw new Error("compress could not identify the visible user turn that owns this call. Nothing was compressed.");
  }
  const parentMatches = rawMessages.map((message, index) => ({ message, index })).filter(({ message }) => message.info.id === parentId && isVisibleUserMessage3(message));
  if (parentMatches.length !== 1 || parentMatches[0].index >= executing.index) {
    throw new Error("compress could not unambiguously resolve this call's visible user boundary. Nothing was compressed.");
  }
  const owner = parentMatches[0];
  const matchingManagementTurn = [...state.managementTurns].reverse().find((turn) => !turn.completedAt && turn.triggerMessageId === parentId);
  if (matchingManagementTurn) {
    if (matchingManagementTurn.source === "squash") {
      throw new Error("compress cannot complete an active `/compress squash` turn. Call squash with one block range instead. Nothing was compressed.");
    }
    return {
      history: rawMessages.slice(0, owner.index),
      managementTurn: matchingManagementTurn
    };
  }
  const interveningVisibleUser = rawMessages.slice(owner.index + 1, executing.index).some(isVisibleUserMessage3);
  if (interveningVisibleUser) {
    throw new Error("compress found another visible user turn between this call and its owner. Nothing was compressed.");
  }
  return { history: rawMessages.slice(0, owner.index) };
}
function buildCompressReceipt(topic, blockId, restoreDisposition) {
  const stored = `Compression complete. Stored [${blockId}] "${topic}" durably; the fold is already in effect.`;
  const finish = `${stored} Do not call compress again this turn.`;
  return restoreDisposition ? `${finish} Automatic compression finished. Continue the original work now, unless the preserved execution steps show it was already complete or awaiting the user.` : finish;
}
function createCompressTool(ctx) {
  return {
    description: COMPRESS_TOOL_DESCRIPTION,
    args: {
      summary: { type: "string", description: "Compact structured continuation handoff described by this tool's instructions" },
      topic: { type: "string", description: "Short block title, usually 3-5 words" }
    },
    async execute(args, toolCtx) {
      const { client, stateManager, logger } = ctx;
      const sessionId = toolCtx.sessionID;
      const state = stateManager.get(sessionId);
      const input = args;
      const summary = typeof input.summary === "string" ? input.summary.trim() : "";
      const topic = typeof input.topic === "string" ? input.topic.trim() : "";
      if (!summary)
        throw new Error("compress requires a non-empty summary");
      if (!topic)
        throw new Error("compress requires a non-empty topic");
      const outcome = await stateManager.runExclusive(sessionId, async () => {
        let rawMessages;
        try {
          rawMessages = await listSessionMessages(client, sessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`compress could not fetch session messages: ${message}. Nothing was compressed.`);
        }
        if (rawMessages.length === 0) {
          throw new Error("compress could not fetch any session messages. Nothing was compressed.");
        }
        await reconcileSessionLifecycle(state, sessionId, logger, rawMessages);
        if (!state.persistenceSynchronized) {
          throw new Error("compress could not synchronize saved session state. Nothing was compressed.");
        }
        const callId = toolCtx.id ?? toolCtx.callID;
        const boundary = resolveCompressionBoundary(rawMessages, state, toolCtx.messageID, callId);
        if (!boundary.managementTurn && getPostCompressionCooldownRemaining(state, rawMessages) > 0) {
          const remaining = getPostCompressionCooldownRemaining(state, rawMessages);
          throw new Error(`Compression succeeded recently. Nothing was compressed. Wait ${remaining} more assistant ${remaining === 1 ? "response" : "responses"}. Only the user may override this cooldown by explicitly running \`/compress manage\`.`);
        }
        const span = selectDeterministicCompressionSpan(boundary.history, state, logger, ctx.config.protectedTurns);
        if (span.messages.length === 0) {
          return { kind: "empty" };
        }
        const containedToolIds = collectToolIdsInRange(span.messages, 0, span.messages.length - 1);
        const estimatedCompressedTokens = estimateTokensBatch(collectContentInRange(span.messages, 0, span.messages.length - 1), state.modelContext?.providerId);
        const candidateCompressed = {
          toolIds: new Set(state.compressed.toolIds),
          messageIds: new Set(state.compressed.messageIds)
        };
        for (const id of containedToolIds)
          candidateCompressed.toolIds.add(id);
        for (const id of span.messageIds)
          candidateCompressed.messageIds.add(id);
        const anchorMessageId = span.messageIds[0];
        const candidateSummaries = [
          ...state.compressSummaries,
          {
            anchorMessageId,
            messageIds: span.messageIds,
            summary,
            topic
          }
        ];
        const storedBlock = orderCompressBlocks(boundary.history, candidateSummaries).find((block) => block.summary === candidateSummaries[candidateSummaries.length - 1]);
        if (!storedBlock) {
          throw new Error("compress could not reconcile the new compressed block with the current transcript. Nothing was compressed.");
        }
        const completedAt = new Date().toISOString();
        const candidateManagementTurns = boundary.managementTurn ? state.managementTurns.map((turn) => turn === boundary.managementTurn ? {
          ...turn,
          completedAt,
          completedMessageId: toolCtx.messageID
        } : turn) : [...state.managementTurns];
        const candidateState = {
          ...state,
          compressed: candidateCompressed,
          compressSummaries: candidateSummaries,
          managementTurns: candidateManagementTurns,
          stats: {
            compressTokenCounter: 0,
            totalCompressTokens: state.stats.totalCompressTokens + estimatedCompressedTokens
          },
          compressionCooldownAfterMessageId: toolCtx.messageID,
          compressionMapSnapshot: undefined
        };
        const persisted = await saveSessionState(candidateState, logger);
        if (!persisted) {
          throw new Error("compress could not persist compression state. Nothing was compressed.");
        }
        commitDurableSessionState(state, candidateState);
        return {
          kind: "compressed",
          containedToolIds,
          selectedMessageCount: span.messageIds.length,
          visibleHistoryCount: span.messageIds.length + span.protectedMessageIds.length,
          topic,
          summary,
          estimatedCompressedTokens,
          storedBlockId: storedBlock.label,
          continueTask: boundary.managementTurn?.source === "automatic",
          currentParams: {
            providerId: state.modelContext?.providerId,
            modelId: state.modelContext?.modelId,
            agent: toolCtx.agent,
            variant: state.variant
          }
        };
      });
      if (outcome.kind === "empty") {
        return "Nothing eligible to compress. The newest configured execution steps and existing blocks remain unchanged.";
      }
      await sendCompressNotification(client, logger, ctx.config, state, sessionId, outcome.containedToolIds, outcome.selectedMessageCount, outcome.topic, outcome.summary, { messageIndex: 0 }, { messageIndex: outcome.selectedMessageCount - 1 }, outcome.visibleHistoryCount, outcome.currentParams, outcome.estimatedCompressedTokens);
      const receipt = buildCompressReceipt(outcome.topic, outcome.storedBlockId, outcome.continueTask);
      return receipt;
    }
  };
}
// lib/tools/squash.ts
var SQUASH_TOOL_DESCRIPTION = loadPrompt("squash-tool-spec");
var BLOCK_LABEL = /^b(?:0|[1-9]\d*)$/;
function parseBlockLabel(value, field) {
  if (typeof value !== "string" || !BLOCK_LABEL.test(value)) {
    throw new Error(`squash requires ${field} to be a current block label such as b1`);
  }
  const index = Number(value.slice(1));
  if (!Number.isSafeInteger(index)) {
    throw new Error(`squash requires ${field} to be a current block label such as b1`);
  }
  return index;
}
function buildReplacement(selected, summary, topic) {
  const messageIds = [];
  const seen = new Set;
  for (const block of selected) {
    for (const messageId of block.summary.messageIds) {
      if (!seen.has(messageId)) {
        seen.add(messageId);
        messageIds.push(messageId);
      }
    }
  }
  return {
    anchorMessageId: selected[0].summary.anchorMessageId,
    messageIds,
    summary,
    topic
  };
}
function createSquashTool(ctx) {
  return {
    description: SQUASH_TOOL_DESCRIPTION,
    args: {
      from: { type: "string", description: "Inclusive current block label, for example b1" },
      to: { type: "string", description: "Inclusive current block label, for example b12" },
      summary: { type: "string", description: "Truthful replacement for only the selected blocks" },
      topic: { type: "string", description: "Short replacement block title" }
    },
    async execute(args, toolCtx) {
      const input = args;
      const fromIndex = parseBlockLabel(input.from, "from");
      const toIndex = parseBlockLabel(input.to, "to");
      const summary = typeof input.summary === "string" ? input.summary.trim() : "";
      const topic = typeof input.topic === "string" ? input.topic.trim() : "";
      if (!summary)
        throw new Error("squash requires a non-empty summary");
      if (!topic)
        throw new Error("squash requires a non-empty topic");
      const { client, stateManager, logger } = ctx;
      const sessionId = toolCtx.sessionID;
      const state = stateManager.get(sessionId);
      const outcome = await stateManager.runExclusive(sessionId, async () => {
        let rawMessages;
        try {
          rawMessages = await listSessionMessages(client, sessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`squash could not fetch session messages: ${message}. Nothing changed.`);
        }
        if (rawMessages.length === 0) {
          throw new Error("squash could not fetch any session messages. Nothing changed.");
        }
        await reconcileSessionLifecycle(state, sessionId, logger, rawMessages);
        if (!state.persistenceSynchronized) {
          throw new Error("squash could not synchronize saved session state. Nothing changed.");
        }
        const orderedBlocks = orderCompressBlocks(rawMessages, state.compressSummaries);
        const active = findActiveManagementTurn(state, rawMessages);
        const managementTurn = active?.turn.source === "squash" ? active.turn : undefined;
        if (fromIndex > toIndex) {
          throw new Error("squash requires from to precede or equal to to. Nothing changed.");
        }
        if (fromIndex >= orderedBlocks.length || toIndex >= orderedBlocks.length) {
          throw new Error("squash block range does not exist in the current block ordering. Nothing changed.");
        }
        if (toIndex - fromIndex + 1 < 2) {
          throw new Error("squash requires a range containing at least two blocks. Nothing changed.");
        }
        const selected = orderedBlocks.slice(fromIndex, toIndex + 1);
        const replacement = buildReplacement(selected, summary, topic);
        const replacementLabel = selected[0].label;
        const oldVisibleTokens = estimateTokensBatch(selected.map(formatCompressBlockContent), state.modelContext?.providerId);
        const newVisibleTokens = estimateTokensBatch([formatCompressBlockContent({ label: replacementLabel, summary: replacement })], state.modelContext?.providerId);
        const estimatedSavedTokens = Math.max(0, oldVisibleTokens - newVisibleTokens);
        const orderedSummaries = orderedBlocks.map((block) => block.summary);
        const candidateSummaries = [
          ...orderedSummaries.slice(0, fromIndex),
          replacement,
          ...orderedSummaries.slice(toIndex + 1)
        ];
        const completedAt = new Date().toISOString();
        const candidateManagementTurns = managementTurn ? state.managementTurns.map((turn) => turn === managementTurn ? {
          ...turn,
          completedAt,
          completedMessageId: toolCtx.messageID
        } : turn) : [...state.managementTurns];
        const candidateState = {
          ...state,
          compressSummaries: candidateSummaries,
          managementTurns: candidateManagementTurns,
          stats: {
            compressTokenCounter: 0,
            totalCompressTokens: state.stats.totalCompressTokens + estimatedSavedTokens
          },
          compressionMapSnapshot: undefined
        };
        const persisted = await saveSessionState(candidateState, logger);
        if (!persisted) {
          throw new Error("squash could not persist compression state. Nothing changed.");
        }
        commitDurableSessionState(state, candidateState);
        return {
          oldFrom: selected[0].label,
          oldTo: selected[selected.length - 1].label,
          newLabel: replacementLabel,
          topic,
          selectedBlocks: selected.length,
          blocksBefore: orderedBlocks.length,
          blocksAfter: candidateSummaries.length,
          oldVisibleTokens,
          newVisibleTokens
        };
      });
      await sendSquashNotification(client, logger, ctx.config, sessionId, outcome);
      return `Squash complete. Replaced [${outcome.oldFrom}]-[${outcome.oldTo}] with [${outcome.newLabel}] "${outcome.topic}" durably; the replacement is already in effect. Uncompressed history was untouched. Do not call squash or compress again this turn.`;
    }
  };
}
// lib/plugin.ts
async function setup(context) {
  const client = pluginClient(context.session);
  const config = getConfig({ directory: context.location.directory });
  if (!config.enabled)
    return () => {
      return;
    };
  const logger = new Logger({ daily: config.dailyLog ?? config.debug, context: config.debug });
  const stateManager = new SessionStateManager;
  const registrations = [];
  logger.info("Context Compress initialized");
  if (config.commands.enabled) {
    registrations.push(await context.command.transform((draft) => {
      draft.add({
        name: "compress",
        description: "Manage deterministic context compression",
        execute: async (input) => {
          await handleCompressCommand({
            command: "compress",
            sessionID: input.sessionID,
            arguments: input.prompt.text
          }, { client, stateManager, logger, config });
        }
      });
    }));
  }
  if (config.tools.compress.permission !== "deny") {
    const compress = createCompressTool({ client, stateManager, logger, config });
    const squash = createSquashTool({ client, stateManager, logger, config });
    registrations.push(await context.tool.transform((draft) => {
      draft.add({
        name: "compress",
        description: compress.description,
        input: z.object({
          summary: z.string().describe(compress.args.summary.description),
          topic: z.string().describe(compress.args.topic.description)
        }),
        options: { codemode: false, permission: "compress" },
        execute: async (input, toolContext) => ({
          content: await compress.execute(input, toolContext)
        })
      });
      draft.add({
        name: "squash",
        description: squash.description,
        input: z.object({
          from: z.string().describe(squash.args.from.description),
          to: z.string().describe(squash.args.to.description),
          summary: z.string().describe(squash.args.summary.description),
          topic: z.string().describe(squash.args.topic.description)
        }),
        options: { codemode: false, permission: "compress" },
        execute: async (input, toolContext) => ({
          content: await squash.execute(input, toolContext)
        })
      });
    }));
  }
  const applyCompression = async (event, kind) => {
    setSessionSelection(client, event.sessionID, {
      agent: event.agent,
      model: {
        providerID: event.model.providerID,
        id: event.model.id,
        variant: event.model.variant
      }
    });
    const messages = await listSessionMessages(client, event.sessionID);
    if (messages.length === 0)
      return;
    const state = stateManager.get(event.sessionID);
    const modelContext = await resolveModelContext(context, event.model);
    let transformed;
    await stateManager.runExclusive(event.sessionID, async () => {
      state.currentAgent = event.agent;
      state.variant = event.model.variant;
      if (modelContext)
        state.modelContext = modelContext;
      let syncResult = await checkSession(state, logger, messages);
      if (!state.persistenceSynchronized) {
        logger.error("Skipping compression for this turn: session state is not synchronized, so the model sees the untransformed transcript", {
          sessionID: event.sessionID,
          source: syncResult.source
        });
        return;
      }
      if (!state.hasPersistedState) {
        await inheritForkCompression(context.session, client, state, logger, messages);
        syncResult = await checkSession(state, logger, messages);
        if (!state.persistenceSynchronized)
          throw new Error("Cannot load inherited fork compression state");
      }
      transformed = transformV2Messages(messages, state, logger, event.messages);
      if (kind === "context" && isPostCompressionNoticeDue(state, messages)) {
        transformed.push({
          role: "user",
          content: [{ type: "text", text: renderPostCompressionNotice() }]
        });
      }
      event.messages.splice(0, event.messages.length, ...transformed);
    });
    if (kind === "context" && transformed)
      await logger.saveContext(event.sessionID, transformed);
  };
  registrations.push(await context.session.hook("context", (event) => applyCompression(event, "context")), await context.session.hook("generate", (event) => applyCompression(event, "generate")));
  const automatic = createAutomaticCompressionEventHandler(client, stateManager, logger, config, async (sessionID, event) => {
    const ref = isRecord3(event) && isRecord3(event.location) ? event.location : undefined;
    if (ref && typeof ref.directory === "string") {
      return ref.directory === context.location.directory && ref.workspaceID === context.location.workspaceID;
    }
    const location = (await context.session.get({ sessionID })).location;
    return location.directory === context.location.directory;
  });
  const events = context.event.subscribe()[Symbol.asyncIterator]();
  const eventLoop = runEvents(events, automatic, client, stateManager, logger, context);
  return async () => {
    await events.return?.();
    await Promise.all(registrations.map((registration) => registration.dispose()));
    await eventLoop;
  };
}
async function resolveModelContext(context, model) {
  const result = await context.model.list();
  const match = result.data.find((value) => value.providerID === model.providerID && value.id === model.id && typeof value.limit.context === "number");
  if (!match)
    return;
  return { providerId: model.providerID, modelId: model.id, contextLimit: match.limit.context };
}
async function runEvents(events, automatic, client, stateManager, logger, context) {
  for (;; ) {
    const item = await events.next().catch((error) => {
      logger.error("Context Compress event stream failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    if (!item || item.done)
      return;
    try {
      await automatic(item.value);
      const event = isRecord3(item.value) ? item.value : {};
      const data = isRecord3(event.data) ? event.data : {};
      if (event.type === "session.forked" && typeof data.sessionID === "string") {
        const location = isRecord3(event.location) ? event.location : undefined;
        if (location && typeof location.directory === "string") {
          if (location.directory !== context.location.directory || location.workspaceID !== context.location.workspaceID)
            continue;
        } else {
          const child = await context.session.get({ sessionID: data.sessionID });
          if (child.location.directory !== context.location.directory)
            continue;
        }
        const messages = await listSessionMessages(client, data.sessionID);
        await stateManager.runExclusive(data.sessionID, async () => {
          const state = stateManager.get(data.sessionID);
          await checkSession(state, logger, messages);
          if (!state.persistenceSynchronized || state.hasPersistedState)
            return;
          await inheritForkCompression(context.session, client, state, logger, messages);
        });
        continue;
      }
      if (event.type !== "session.compaction.ended" || typeof data.sessionID !== "string")
        continue;
      const messages = await listSessionMessages(client, data.sessionID);
      await stateManager.runExclusive(data.sessionID, () => reconcileSessionLifecycle(stateManager.get(data.sessionID), data.sessionID, logger, messages));
    } catch (error) {
      logger.error("Context Compress event handling failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// index.ts
var context_compress_default = Plugin.define({
  id: "opencode-context-compress",
  setup
});
export {
  context_compress_default as default
};

//# debugId=C9D6F0303881A17264756E2164756E21
//# sourceMappingURL=index.js.map
