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
        };
    });
}
export async function saveSessionState(sessionState, logger, sessionName) {
    try {
        if (!sessionState.sessionId) {
            return;
        }
        await ensureStorageDir();
        const state = {
            sessionName: sessionName,
            compressed: {
                toolIds: [...sessionState.compressed.toolIds],
                messageIds: [...sessionState.compressed.messageIds],
            },
            compressSummaries: sessionState.compressSummaries,
            stats: sessionState.stats,
            lastUpdated: new Date().toISOString(),
        };
        const filePath = getSessionFilePath(sessionState.sessionId);
        const content = JSON.stringify(state, null, 2);
        await fs.writeFile(filePath, content, "utf-8");
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
    try {
        const filePath = getSessionFilePath(sessionId);
        let state;
        let migrated = false;
        if (existsSync(filePath)) {
            const content = await fs.readFile(filePath, "utf-8");
            state = JSON.parse(content);
        }
        else {
            // Fall back to legacy storage path
            const legacyPath = getLegacySessionFilePath(sessionId);
            if (!existsSync(legacyPath)) {
                return null;
            }
            logger.info("Found legacy state file, migrating", { sessionId });
            const content = await fs.readFile(legacyPath, "utf-8");
            const legacy = JSON.parse(content);
            state = remapLegacyState(legacy);
            migrated = true;
        }
        if (!state || !state.compressed || !Array.isArray(state.compressed.toolIds) || !state.stats) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            });
            return null;
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
        // One-time migration: save to new path so legacy fallback only runs once
        if (migrated) {
            try {
                await ensureStorageDir();
                const newFilePath = getSessionFilePath(sessionId);
                await fs.writeFile(newFilePath, JSON.stringify(result, null, 2), "utf-8");
                logger.info("Migrated legacy state to compress path", { sessionId });
            }
            catch (saveError) {
                logger.warn("Failed to save migrated state (will retry next load)", {
                    sessionId,
                    error: saveError?.message,
                });
            }
        }
        return result;
    }
    catch (error) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        });
        return null;
    }
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