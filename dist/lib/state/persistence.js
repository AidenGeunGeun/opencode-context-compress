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
        stats: {
            compressTokenCounter: legacy.stats?.pruneTokenCounter ?? 0,
            totalCompressTokens: legacy.stats?.totalPruneTokens ?? 0,
        },
        lastUpdated: legacy.lastUpdated,
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
            return;
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
            stats: sessionState.stats,
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
    }
    catch (error) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        });
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
    const result = {
        sessionName: state.sessionName,
        compressed: state.compressed,
        compressSummaries,
        stats: state.stats,
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
function scaleStats(stats, originalMessageCount, migratedMessageCount) {
    if (originalMessageCount <= 0 || migratedMessageCount <= 0) {
        return {
            compressTokenCounter: 0,
            totalCompressTokens: 0,
        };
    }
    if (migratedMessageCount >= originalMessageCount) {
        return stats;
    }
    const ratio = migratedMessageCount / originalMessageCount;
    return {
        compressTokenCounter: Math.round((stats.compressTokenCounter || 0) * ratio),
        totalCompressTokens: Math.round((stats.totalCompressTokens || 0) * ratio),
    };
}
export async function forkSessionState(input, logger) {
    const source = await loadSessionState(input.sourceSessionId, logger);
    if (source.status === "missing")
        return { status: "missing" };
    if (source.status === "error")
        return { status: "error" };
    const messageIdMap = new Map(Object.entries(input.messageIdMap));
    if (messageIdMap.size === 0)
        return { status: "skipped", reason: "empty-message-map" };
    const sourceState = source.state;
    const sourceCompressedMessageIds = new Set(sourceState.compressed.messageIds || []);
    const toolIdsByMessageId = input.toolIdsByMessageId;
    const migratedSourceMessageIds = new Set();
    const migratedSourceToolIds = new Set();
    const compressSummaries = [];
    let droppedSummaries = 0;
    for (const summary of sourceState.compressSummaries || []) {
        const sourceMessageIds = [...new Set(summary.messageIds || [])];
        const fullyCopied = sourceMessageIds.length > 0 &&
            messageIdMap.has(summary.anchorMessageId) &&
            sourceMessageIds.every((messageId) => messageIdMap.has(messageId));
        if (!fullyCopied) {
            droppedSummaries++;
            continue;
        }
        for (const messageId of sourceMessageIds) {
            migratedSourceMessageIds.add(messageId);
            for (const toolId of toolIdsByMessageId[messageId] || []) {
                if (sourceState.compressed.toolIds.includes(toolId))
                    migratedSourceToolIds.add(toolId);
            }
        }
        compressSummaries.push({
            anchorMessageId: messageIdMap.get(summary.anchorMessageId),
            messageIds: sourceMessageIds.map((messageId) => messageIdMap.get(messageId)),
            summary: summary.summary,
            ...(summary.topic && { topic: summary.topic }),
        });
    }
    const compressedMessageIds = [...migratedSourceMessageIds]
        .filter((messageId) => sourceCompressedMessageIds.has(messageId))
        .map((messageId) => messageIdMap.get(messageId));
    const compressedToolIds = [...migratedSourceToolIds];
    if (compressedMessageIds.length === 0 && compressedToolIds.length === 0 && compressSummaries.length === 0) {
        return { status: "skipped", reason: "empty-migrated-state" };
    }
    await ensureStorageDir();
    const lastUpdated = new Date().toISOString();
    const targetState = {
        sessionName: input.sessionName ?? sourceState.sessionName,
        compressed: {
            toolIds: compressedToolIds,
            messageIds: compressedMessageIds,
        },
        compressSummaries,
        stats: scaleStats(sourceState.stats, sourceState.compressed.messageIds.length, compressedMessageIds.length),
        lastUpdated,
    };
    await writeFileAtomic(getSessionFilePath(input.targetSessionId), JSON.stringify(targetState, null, 2));
    const droppedMessages = sourceState.compressed.messageIds.filter((messageId) => !migratedSourceMessageIds.has(messageId)).length;
    logger.info("Forked persisted compression state", {
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        summaries: compressSummaries.length,
        compressedMessages: compressedMessageIds.length,
        compressedTools: compressedToolIds.length,
        droppedSummaries,
        droppedMessages,
    });
    return {
        status: "migrated",
        summaries: compressSummaries.length,
        compressedMessages: compressedMessageIds.length,
        compressedTools: compressedToolIds.length,
        droppedSummaries,
        droppedMessages,
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