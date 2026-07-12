/**
 * State persistence module for Context Compress plugin.
 * Persists compressed tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/compress/{sessionId}.json
 */
import * as fs from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
const STORAGE_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "storage", "plugin", "compress");
/** Legacy storage dir from before the context-compress rebrand */
const LEGACY_STORAGE_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "storage", "plugin", "dcp");
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
        }
        finally {
            await handle.close();
        }
        await fs.rename(tempPath, filePath);
        tempFileCreated = false;
    }
    finally {
        if (tempFileCreated) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
        }
    }
}
async function readJsonFile(filePath) {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return {
            status: "loaded",
            data: JSON.parse(content),
        };
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            return { status: "missing" };
        }
        return {
            status: "error",
            error,
        };
    }
}
function getSessionFilePath(sessionId) {
    return join(STORAGE_DIR, `${sessionId}.json`);
}
function getLegacySessionFilePath(sessionId) {
    return join(LEGACY_STORAGE_DIR, `${sessionId}.json`);
}
/**
 * Remap legacy persisted state to the current (compress) format.
 * Transforms: prune → compressed, pruneTokenCounter → compressTokenCounter,
 * totalPruneTokens → totalCompressTokens.
 */
function remapLegacyState(legacy) {
    return {
        sessionName: legacy.sessionName,
        compressed: {
            toolIds: legacy.prune?.toolIds ?? [],
            messageIds: legacy.prune?.messageIds ?? [],
        },
        compressSummaries: legacy.compressSummaries ?? [],
        managementTurns: [],
        stats: {
            compressTokenCounter: legacy.stats?.pruneTokenCounter ?? 0,
            totalCompressTokens: legacy.stats?.totalPruneTokens ?? 0,
        },
        lastUpdated: legacy.lastUpdated,
    };
}
function normalizeManagementTurns(turns) {
    if (!Array.isArray(turns)) {
        return [];
    }
    const normalized = [];
    const seen = new Set();
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
            ...(typeof turn.retainedText === "string" && turn.retainedText.length > 0
                ? { retainedText: turn.retainedText }
                : {}),
            ...(typeof turn.completedAt === "string" && turn.completedAt.length > 0
                ? { completedAt: turn.completedAt }
                : {}),
            ...(typeof turn.completedCallId === "string" && turn.completedCallId.length > 0
                ? { completedCallId: turn.completedCallId }
                : {}),
            ...(typeof turn.completedMessageId === "string" && turn.completedMessageId.length > 0
                ? { completedMessageId: turn.completedMessageId }
                : {}),
            ...(turn.source === "automatic" ? { source: "automatic" } : {}),
            ...(typeof turn.triggeredByMessageId === "string" && turn.triggeredByMessageId.length > 0
                ? { triggeredByMessageId: turn.triggeredByMessageId }
                : {}),
            ...(Array.isArray(turn.protectedMessageIds)
                ? {
                    protectedMessageIds: [
                        ...new Set(turn.protectedMessageIds.filter((messageId) => typeof messageId === "string" && messageId.length > 0)),
                    ],
                }
                : {}),
            ...(typeof turn.contextTokens === "number" && Number.isFinite(turn.contextTokens)
                ? { contextTokens: turn.contextTokens }
                : {}),
            ...(typeof turn.thresholdTokens === "number" && Number.isFinite(turn.thresholdTokens)
                ? { thresholdTokens: turn.thresholdTokens }
                : {}),
        });
    }
    return normalized;
}
function normalizeCompressionMapSnapshot(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const snapshot = value;
    if (typeof snapshot.triggerMessageId !== "string" ||
        snapshot.triggerMessageId.length === 0 ||
        !Array.isArray(snapshot.entries)) {
        return undefined;
    }
    const keys = new Set();
    const physicalMessageIds = new Set();
    const physicalToolIds = new Set();
    const entries = [];
    let nextNumericKey = 1;
    for (const valueEntry of snapshot.entries) {
        if (!valueEntry || typeof valueEntry !== "object")
            return undefined;
        const entry = valueEntry;
        const key = entry.key;
        const validKey = (typeof key === "number" && Number.isSafeInteger(key) && key > 0) ||
            (typeof key === "string" && /^b\d+$/.test(key));
        if (!validKey || keys.has(key))
            return undefined;
        if (entry.kind !== "message" && entry.kind !== "block")
            return undefined;
        if ((entry.kind === "message" && typeof key !== "number") ||
            (entry.kind === "block" && typeof key !== "string")) {
            return undefined;
        }
        if (entry.kind === "message" && key !== nextNumericKey++)
            return undefined;
        if (!Array.isArray(entry.rawMessageIds) ||
            entry.rawMessageIds.length === 0 ||
            !entry.rawMessageIds.every((messageId) => typeof messageId === "string" && messageId.length > 0)) {
            return undefined;
        }
        const rawMessageIds = entry.rawMessageIds;
        if (entry.kind === "message" && rawMessageIds.length !== 1)
            return undefined;
        if (new Set(rawMessageIds).size !== rawMessageIds.length)
            return undefined;
        if (rawMessageIds.some((messageId) => physicalMessageIds.has(messageId)))
            return undefined;
        if (!Array.isArray(entry.toolIds) ||
            !entry.toolIds.every((toolId) => typeof toolId === "string" && toolId.length > 0)) {
            return undefined;
        }
        const toolIds = entry.toolIds;
        if (new Set(toolIds).size !== toolIds.length)
            return undefined;
        if (toolIds.some((toolId) => physicalToolIds.has(toolId)))
            return undefined;
        if (entry.kind === "block" && toolIds.length > 0)
            return undefined;
        if (typeof entry.tokenEstimate !== "number" ||
            !Number.isFinite(entry.tokenEstimate) ||
            entry.tokenEstimate < 0) {
            return undefined;
        }
        if (entry.kind === "block" &&
            (typeof entry.anchorMessageId !== "string" || entry.anchorMessageId.length === 0)) {
            return undefined;
        }
        if (entry.kind === "block" &&
            !rawMessageIds.includes(entry.anchorMessageId)) {
            return undefined;
        }
        if (entry.kind === "message" && entry.anchorMessageId !== undefined)
            return undefined;
        if (entry.protected !== undefined && typeof entry.protected !== "boolean") {
            return undefined;
        }
        keys.add(key);
        rawMessageIds.forEach((messageId) => physicalMessageIds.add(messageId));
        toolIds.forEach((toolId) => physicalToolIds.add(toolId));
        entries.push({
            key: key,
            kind: entry.kind,
            rawMessageIds,
            ...(typeof entry.anchorMessageId === "string"
                ? { anchorMessageId: entry.anchorMessageId }
                : {}),
            ...(entry.protected === true ? { protected: true } : {}),
            toolIds,
            tokenEstimate: entry.tokenEstimate,
        });
    }
    return {
        triggerMessageId: snapshot.triggerMessageId,
        entries,
    };
}
export function backfillCompressSummaryMessageIds(summaries, messages, compressedMessageIds) {
    return summaries.map((summary) => {
        if (Array.isArray(summary.messageIds) && summary.messageIds.length > 0) {
            return {
                anchorMessageId: summary.anchorMessageId,
                messageIds: [...new Set(summary.messageIds)],
                summary: summary.summary,
                ...(summary.topic && { topic: summary.topic }),
            };
        }
        const anchorIndex = messages.findIndex((msg) => msg.info.id === summary.anchorMessageId);
        const messageIds = [];
        if (anchorIndex !== -1 && compressedMessageIds.has(summary.anchorMessageId)) {
            for (let i = anchorIndex; i < messages.length; i++) {
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
            ...(summary.topic && { topic: summary.topic }),
        };
    });
}
export async function saveSessionState(sessionState, logger, sessionName) {
    try {
        if (!sessionState.sessionId) {
            return false;
        }
        await ensureStorageDir();
        const lastUpdated = new Date().toISOString();
        const state = {
            sessionName: sessionName,
            compressed: {
                toolIds: [...sessionState.compressed.toolIds],
                messageIds: [...sessionState.compressed.messageIds],
            },
            compressSummaries: sessionState.compressSummaries,
            managementTurns: sessionState.managementTurns,
            ...(sessionState.compressionMapSnapshot
                ? { compressionMapSnapshot: sessionState.compressionMapSnapshot }
                : {}),
            stats: sessionState.stats,
            ...(typeof sessionState.autoCompressionEnabledOverride === "boolean"
                ? { autoCompressionEnabledOverride: sessionState.autoCompressionEnabledOverride }
                : {}),
            ...(sessionState.autoCompressionTokenThresholdOverride !== undefined
                ? {
                    autoCompressionTokenThresholdOverride: sessionState.autoCompressionTokenThresholdOverride,
                }
                : {}),
            ...(sessionState.autoCompressionContextWindowRatioOverride !== undefined
                ? {
                    autoCompressionContextWindowRatioOverride: sessionState.autoCompressionContextWindowRatioOverride,
                }
                : {}),
            ...(sessionState.compressionCooldownAfterMessageId
                ? {
                    compressionCooldownAfterMessageId: sessionState.compressionCooldownAfterMessageId,
                }
                : {}),
            ...(sessionState.lastCompaction > 0
                ? { lastCompaction: sessionState.lastCompaction }
                : {}),
            lastUpdated,
        };
        const filePath = getSessionFilePath(sessionState.sessionId);
        const content = JSON.stringify(state, null, 2);
        await writeFileAtomic(filePath, content);
        sessionState.hasPersistedState = true;
        sessionState.persistedLastUpdated = lastUpdated;
        logger.info("Saved session state to disk", {
            sessionId: sessionState.sessionId,
            totalTokensSaved: state.stats.totalCompressTokens,
        });
        return true;
    }
    catch (error) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        });
        return false;
    }
}
export async function loadSessionState(sessionId, logger, messages) {
    const filePath = getSessionFilePath(sessionId);
    const primaryResult = await readJsonFile(filePath);
    let state;
    let migrated = false;
    if (primaryResult.status === "loaded") {
        state = primaryResult.data;
    }
    else if (primaryResult.status === "error") {
        logger.warn("Failed to load session state", {
            sessionId,
            path: filePath,
            error: primaryResult.error?.message,
        });
        return { status: "error" };
    }
    else {
        const legacyPath = getLegacySessionFilePath(sessionId);
        const legacyResult = await readJsonFile(legacyPath);
        if (legacyResult.status === "missing") {
            return { status: "missing" };
        }
        if (legacyResult.status === "error") {
            logger.warn("Failed to load legacy session state", {
                sessionId,
                path: legacyPath,
                error: legacyResult.error?.message,
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
            path: migrated ? getLegacySessionFilePath(sessionId) : filePath,
        });
        return { status: "error" };
    }
    if (!Array.isArray(state.compressed.messageIds)) {
        state.compressed.messageIds = [];
    }
    let compressSummaries = [];
    if (Array.isArray(state.compressSummaries)) {
        const validSummaries = state.compressSummaries.filter((s) => s !== null &&
            typeof s === "object" &&
            typeof s.anchorMessageId === "string" &&
            typeof s.summary === "string" &&
            (s.messageIds === undefined ||
                (Array.isArray(s.messageIds) &&
                    s.messageIds.every((messageId) => typeof messageId === "string"))));
        if (validSummaries.length !== state.compressSummaries.length) {
            logger.warn("Filtered out malformed compressSummaries entries", {
                sessionId: sessionId,
                original: state.compressSummaries.length,
                valid: validSummaries.length,
            });
        }
        if (messages) {
            compressSummaries = backfillCompressSummaryMessageIds(validSummaries, messages, new Set(state.compressed.messageIds));
        }
        else {
            compressSummaries = validSummaries.map((summary) => ({
                anchorMessageId: summary.anchorMessageId,
                messageIds: Array.isArray(summary.messageIds) && summary.messageIds.length > 0
                    ? [...new Set(summary.messageIds)]
                    : [summary.anchorMessageId],
                summary: summary.summary,
                ...(summary.topic && { topic: summary.topic }),
            }));
        }
    }
    logger.info("Loaded session state from disk", {
        sessionId: sessionId,
        migrated,
    });
    const managementTurns = normalizeManagementTurns(state.managementTurns);
    const normalizedSnapshot = normalizeCompressionMapSnapshot(state.compressionMapSnapshot);
    const latestIncompleteTurn = [...managementTurns].reverse().find((turn) => !turn.completedAt);
    const snapshotBlocks = normalizedSnapshot?.entries.filter((entry) => entry.kind === "block") ?? [];
    const snapshotBlocksMatchSummaries = snapshotBlocks.every((entry) => {
        const summary = compressSummaries.find((candidate) => candidate.anchorMessageId === entry.anchorMessageId);
        return (summary !== undefined &&
            summary.messageIds.length === entry.rawMessageIds.length &&
            summary.messageIds.every((messageId, index) => messageId === entry.rawMessageIds[index]));
    });
    const allSummariesArePinned = compressSummaries.every((summary) => snapshotBlocks.some((entry) => entry.anchorMessageId === summary.anchorMessageId));
    const completeBlockOrderIsValid = !allSummariesArePinned ||
        snapshotBlocks.every((entry, index) => entry.key === `b${index}`);
    const snapshotMatchesState = Boolean(normalizedSnapshot &&
        normalizedSnapshot.triggerMessageId === latestIncompleteTurn?.triggerMessageId &&
        snapshotBlocksMatchSummaries &&
        completeBlockOrderIsValid);
    const compressionMapSnapshot = snapshotMatchesState ? normalizedSnapshot : undefined;
    const result = {
        sessionName: state.sessionName,
        compressed: state.compressed,
        compressSummaries,
        managementTurns,
        ...(compressionMapSnapshot ? { compressionMapSnapshot } : {}),
        stats: state.stats,
        ...(typeof state.autoCompressionEnabledOverride === "boolean"
            ? { autoCompressionEnabledOverride: state.autoCompressionEnabledOverride }
            : {}),
        ...(typeof state.autoCompressionTokenThresholdOverride === "number" &&
            Number.isSafeInteger(state.autoCompressionTokenThresholdOverride) &&
            state.autoCompressionTokenThresholdOverride > 0
            ? {
                autoCompressionTokenThresholdOverride: state.autoCompressionTokenThresholdOverride,
            }
            : {}),
        ...(typeof state.autoCompressionContextWindowRatioOverride === "number" &&
            Number.isFinite(state.autoCompressionContextWindowRatioOverride) &&
            state.autoCompressionContextWindowRatioOverride > 0 &&
            state.autoCompressionContextWindowRatioOverride < 1
            ? {
                autoCompressionContextWindowRatioOverride: state.autoCompressionContextWindowRatioOverride,
            }
            : {}),
        ...(typeof state.compressionCooldownAfterMessageId === "string" &&
            state.compressionCooldownAfterMessageId.length > 0
            ? {
                compressionCooldownAfterMessageId: state.compressionCooldownAfterMessageId,
            }
            : {}),
        ...(typeof state.lastCompaction === "number" &&
            Number.isFinite(state.lastCompaction) &&
            state.lastCompaction > 0
            ? { lastCompaction: state.lastCompaction }
            : {}),
        lastUpdated: state.lastUpdated,
    };
    if (migrated) {
        try {
            await ensureStorageDir();
            const newFilePath = getSessionFilePath(sessionId);
            await writeFileAtomic(newFilePath, JSON.stringify(result, null, 2));
            logger.info("Migrated legacy state to compress path", { sessionId });
        }
        catch (saveError) {
            logger.warn("Failed to save migrated state (will retry next load)", {
                sessionId,
                error: saveError?.message,
            });
        }
    }
    return {
        status: "loaded",
        state: result,
    };
}
export async function loadAllSessionStats(logger) {
    const result = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
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
            }
            catch {
                // Skip invalid files
            }
        }
        logger.debug("Loaded all-time stats", result);
    }
    catch (error) {
        logger.warn("Failed to load all-time stats", { error: error?.message });
    }
    return result;
}
//# sourceMappingURL=persistence.js.map