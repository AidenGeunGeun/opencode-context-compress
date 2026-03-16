/**
 * State persistence module for Context Compress plugin.
 * Persists compressed tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/compress/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { SessionState, SessionStats, CompressSummary, WithParts } from "./types"
import type { Logger } from "../logger"

/** Compressed state as stored on disk (arrays for JSON compatibility) */
export interface PersistedCompressed {
    toolIds: string[]
    messageIds: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    compressed: PersistedCompressed
    compressSummaries: CompressSummary[]
    stats: SessionStats
    lastUpdated: string
}

interface PersistedSessionStateFile {
    sessionName?: string
    compressed: PersistedCompressed
    compressSummaries: MaybeBackfilledCompressSummary[]
    stats: SessionStats
    lastUpdated: string
}

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "compress",
)

/** Legacy storage dir from before the context-compress rebrand */
const LEGACY_STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

async function ensureStorageDir(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
        await fs.mkdir(STORAGE_DIR, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json`)
}

function getLegacySessionFilePath(sessionId: string): string {
    return join(LEGACY_STORAGE_DIR, `${sessionId}.json`)
}

/** Old persisted state format (pre-rebrand): used `prune` key and prune-prefixed stats */
interface LegacyPersistedSessionStateFile {
    sessionName?: string
    prune: PersistedCompressed
    compressSummaries?: MaybeBackfilledCompressSummary[]
    stats: {
        pruneTokenCounter: number
        totalPruneTokens: number
    }
    lastUpdated: string
}

/**
 * Remap legacy persisted state to the current (compress) format.
 * Transforms: prune → compressed, pruneTokenCounter → compressTokenCounter,
 * totalPruneTokens → totalCompressTokens.
 */
function remapLegacyState(legacy: LegacyPersistedSessionStateFile): PersistedSessionStateFile {
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
    }
}

type MaybeBackfilledCompressSummary = Omit<CompressSummary, "messageIds"> & {
    messageIds?: string[]
}

export function backfillCompressSummaryMessageIds(
    summaries: MaybeBackfilledCompressSummary[],
    messages: WithParts[],
    compressedMessageIds: Set<string>,
): CompressSummary[] {
    return summaries.map((summary) => {
        if (Array.isArray(summary.messageIds) && summary.messageIds.length > 0) {
            return {
                anchorMessageId: summary.anchorMessageId,
                messageIds: [...new Set(summary.messageIds)],
                summary: summary.summary,
            }
        }

        const anchorIndex = messages.findIndex((msg) => msg.info.id === summary.anchorMessageId)
        const messageIds: string[] = []

        if (anchorIndex !== -1 && compressedMessageIds.has(summary.anchorMessageId)) {
            for (let i = anchorIndex; i < messages.length; i++) {
                const messageId = messages[i].info.id
                if (!compressedMessageIds.has(messageId)) {
                    break
                }
                if (!messageIds.includes(messageId)) {
                    messageIds.push(messageId)
                }
            }
        }

        if (messageIds.length === 0) {
            messageIds.push(summary.anchorMessageId)
        }

        return {
            anchorMessageId: summary.anchorMessageId,
            messageIds,
            summary: summary.summary,
        }
    })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return
        }

        await ensureStorageDir()

        const state: PersistedSessionState = {
            sessionName: sessionName,
            compressed: {
                toolIds: [...sessionState.compressed.toolIds],
                messageIds: [...sessionState.compressed.messageIds],
            },
            compressSummaries: sessionState.compressSummaries,
            stats: sessionState.stats,
            lastUpdated: new Date().toISOString(),
        }

        const filePath = getSessionFilePath(sessionState.sessionId)
        const content = JSON.stringify(state, null, 2)
        await fs.writeFile(filePath, content, "utf-8")

        logger.info("Saved session state to disk", {
            sessionId: sessionState.sessionId,
            totalTokensSaved: state.stats.totalCompressTokens,
        })
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        })
    }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
    messages?: WithParts[],
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        let state: PersistedSessionStateFile
        let migrated = false

        if (existsSync(filePath)) {
            const content = await fs.readFile(filePath, "utf-8")
            state = JSON.parse(content) as PersistedSessionStateFile
        } else {
            // Fall back to legacy storage path
            const legacyPath = getLegacySessionFilePath(sessionId)
            if (!existsSync(legacyPath)) {
                return null
            }

            logger.info("Found legacy state file, migrating", { sessionId })
            const content = await fs.readFile(legacyPath, "utf-8")
            const legacy = JSON.parse(content) as LegacyPersistedSessionStateFile
            state = remapLegacyState(legacy)
            migrated = true
        }

        if (!state || !state.compressed || !Array.isArray(state.compressed.toolIds) || !state.stats) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        if (!Array.isArray(state.compressed.messageIds)) {
            state.compressed.messageIds = []
        }

        let compressSummaries: CompressSummary[] = []
        if (Array.isArray(state.compressSummaries)) {
            const validSummaries = state.compressSummaries.filter(
                (s) =>
                    s !== null &&
                    typeof s === "object" &&
                    typeof s.anchorMessageId === "string" &&
                    typeof s.summary === "string" &&
                    (s.messageIds === undefined ||
                        (Array.isArray(s.messageIds) &&
                            s.messageIds.every((messageId) => typeof messageId === "string"))),
            )
            if (validSummaries.length !== state.compressSummaries.length) {
                logger.warn("Filtered out malformed compressSummaries entries", {
                    sessionId: sessionId,
                    original: state.compressSummaries.length,
                    valid: validSummaries.length,
                })
            }
            if (messages) {
                compressSummaries = backfillCompressSummaryMessageIds(
                    validSummaries,
                    messages,
                    new Set(state.compressed.messageIds),
                )
            } else {
                compressSummaries = validSummaries.map((summary) => ({
                    anchorMessageId: summary.anchorMessageId,
                    messageIds:
                        Array.isArray(summary.messageIds) && summary.messageIds.length > 0
                            ? [...new Set(summary.messageIds)]
                            : [summary.anchorMessageId],
                    summary: summary.summary,
                }))
            }
        }

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
            migrated,
        })

        const result: PersistedSessionState = {
            sessionName: state.sessionName,
            compressed: state.compressed,
            compressSummaries,
            stats: state.stats,
            lastUpdated: state.lastUpdated,
        }

        // One-time migration: save to new path so legacy fallback only runs once
        if (migrated) {
            try {
                await ensureStorageDir()
                const newFilePath = getSessionFilePath(sessionId)
                await fs.writeFile(newFilePath, JSON.stringify(result, null, 2), "utf-8")
                logger.info("Migrated legacy state to compress path", { sessionId })
            } catch (saveError: any) {
                logger.warn("Failed to save migrated state (will retry next load)", {
                    sessionId,
                    error: saveError?.message,
                })
            }
        }

        return result
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        if (!existsSync(STORAGE_DIR)) {
            return result
        }

        const files = await fs.readdir(STORAGE_DIR)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(STORAGE_DIR, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionStateFile

                if (state?.stats?.totalCompressTokens && state?.compressed?.toolIds) {
                    result.totalTokens += state.stats.totalCompressTokens
                    result.totalTools += state.compressed.toolIds.length
                    result.totalMessages += state.compressed.messageIds?.length || 0
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
