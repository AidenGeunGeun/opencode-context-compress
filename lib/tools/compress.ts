import { tool } from "@opencode-ai/plugin/tool"
import type { WithParts, CompressSummary, SessionState } from "../state/index.js"
import type { CompressToolContext } from "./types.js"
import { commitDurableSessionState } from "../state/index.js"
import { saveSessionState } from "../state/persistence.js"
import { loadPrompt } from "../prompts/index.js"
import { estimateTokensBatch } from "../token-utils.js"
import {
    collectContentInRange,
    collectToolIdsInRange,
} from "./utils.js"
import { sendCompressNotification } from "../ui/notification.js"
import {
    contextMapFromCompressionSnapshot,
    resolveContextMapRange,
    type ResolvedContextMapRange,
} from "../messages/context-map.js"

const COMPRESS_TOOL_DESCRIPTION = loadPrompt("compress-tool-spec")

interface CompressRangeInput {
    from: number | string
    to: number | string
    summary: string
    topic: string
}

export function removeSubsumedCompressSummaries(
    summaries: CompressSummary[],
    containedMessageIds: string[],
): CompressSummary[] {
    const containedIds = new Set(containedMessageIds)
    return summaries.filter((summary) => {
        if (containedIds.has(summary.anchorMessageId)) {
            return false
        }

        const summaryMessageIds = Array.isArray(summary.messageIds) ? summary.messageIds : []
        return !summaryMessageIds.some((messageId) => containedIds.has(messageId))
    })
}

/**
 * Strip recursive preservation/section markers from a summary to prevent
 * nested "[Preserved from previous compression] [Preserved from ..." chains
 * when blocks are re-compressed multiple times.
 */
function stripPreservationMarkers(text: string): string {
    return text
        .replace(/^\[Preserved from previous compression\]\s*/gm, "")
        .replace(/^\[Preserved context\]\s*/gm, "")
        .replace(/^\[New content\]\s*/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

export function composeSummaryWithPreservedBlocks(
    preservedSummaries: string[],
    newSummary: string,
): string {
    if (preservedSummaries.length === 0) {
        return newSummary.trim()
    }

    const cleaned = preservedSummaries
        .map(stripPreservationMarkers)
        .filter(Boolean)

    if (cleaned.length === 0) {
        return newSummary.trim()
    }

    return [
        "[Preserved context]",
        ...cleaned,
        "",
        "[New content]",
        newSummary.trim(),
    ].join("\n")
}

export interface CompressionRangeMetrics {
    messageIds: string[]
    nonBlockMessageIds: string[]
    mapEntryCount: number
    toolIds: string[]
    blockTokenEstimate: number
    nonBlockTokenEstimate: number
    estimatedCompressedTokens: number
    incrementalCompressTokens: number
}

export function calculateCompressionRangeMetrics(
    rawMessages: WithParts[],
    rawMessageIndexById: Map<string, number>,
    resolvedRange: ResolvedContextMapRange,
    providerId?: string,
): CompressionRangeMetrics {
    const nonBlockMessageIdsSet = new Set(resolvedRange.nonBlockMessageIds)
    const nonBlockRawMessages = rawMessages
        .filter((msg) => nonBlockMessageIdsSet.has(msg.info.id))
        .sort(
            (a, b) =>
                (rawMessageIndexById.get(a.info.id) ?? Number.MAX_SAFE_INTEGER) -
                (rawMessageIndexById.get(b.info.id) ?? Number.MAX_SAFE_INTEGER),
        )

    const toolIds =
        nonBlockRawMessages.length > 0
            ? collectToolIdsInRange(nonBlockRawMessages, 0, nonBlockRawMessages.length - 1)
            : []

    const nonBlockTokenEstimate =
        nonBlockRawMessages.length > 0
            ? estimateTokensBatch(collectContentInRange(nonBlockRawMessages, 0, nonBlockRawMessages.length - 1), providerId)
            : 0
    const blockTokenEstimate = resolvedRange.entries
        .filter((entry) => entry.kind === "block")
        .reduce((sum, entry) => sum + entry.tokenEstimate, 0)

    return {
        messageIds: resolvedRange.messageIds,
        nonBlockMessageIds: resolvedRange.nonBlockMessageIds,
        mapEntryCount: resolvedRange.mapEntryCount,
        toolIds,
        blockTokenEstimate,
        nonBlockTokenEstimate,
        estimatedCompressedTokens: blockTokenEstimate + nonBlockTokenEstimate,
        incrementalCompressTokens: nonBlockTokenEstimate,
    }
}

export function calculatePinnedCompressionRangeMetrics(
    resolvedRange: ResolvedContextMapRange,
): CompressionRangeMetrics {
    const toolIds = [
        ...new Set(
            resolvedRange.entries
                .filter((entry) => entry.kind === "message")
                .flatMap((entry) => entry.toolIds),
        ),
    ]
    const blockTokenEstimate = resolvedRange.entries
        .filter((entry) => entry.kind === "block")
        .reduce((sum, entry) => sum + entry.tokenEstimate, 0)
    const nonBlockTokenEstimate = resolvedRange.entries
        .filter((entry) => entry.kind === "message")
        .reduce((sum, entry) => sum + entry.tokenEstimate, 0)

    return {
        messageIds: resolvedRange.messageIds,
        nonBlockMessageIds: resolvedRange.nonBlockMessageIds,
        mapEntryCount: resolvedRange.mapEntryCount,
        toolIds,
        blockTokenEstimate,
        nonBlockTokenEstimate,
        estimatedCompressedTokens: blockTokenEstimate + nonBlockTokenEstimate,
        incrementalCompressTokens: nonBlockTokenEstimate,
    }
}

/**
 * Select the final stored summary for a compression range.
 *
 * If the range contains only existing compressed blocks and no new raw messages
 * (pure-block condense), the model's summary is used directly — prepending the
 * old block content verbatim would double the stored size and defeat the purpose.
 *
 * If the range mixes blocks and new messages, the old block content is preserved
 * alongside the new summary so nothing is silently dropped.
 */
export function selectFinalSummary(
    preservedSummaries: string[],
    newSummary: string,
    nonBlockMessageIds: string[],
): string {
    if (nonBlockMessageIds.length === 0) {
        // Pure-block condense: model already has all block content in context,
        // so its summary IS the condensed version — no need to re-wrap originals.
        return newSummary.trim()
    }
    return composeSummaryWithPreservedBlocks(preservedSummaries, newSummary)
}

function buildCompressReceipt(topic: string, blockId?: string, continueTask = false): string {
    const stored = blockId
        ? `Compression complete. Stored [${blockId}] "${topic}" durably; the fold is already in effect.`
        : `Compression complete. Stored "${topic}" durably; the fold is already in effect.`
    const finish = `${stored} Do not call compress or compress_map again this turn.`
    return continueTask
        ? `${finish} Continue the original task now from the preserved active tail; do not stop for a compression report.`
        : finish
}

export function createCompressTool(ctx: CompressToolContext): ReturnType<typeof tool> {
    return tool({
        description: COMPRESS_TOOL_DESCRIPTION,
        args: {
            from: tool.schema
                .union([tool.schema.number(), tool.schema.string()])
                .describe("Range start index from <compress-context-map>, or block reference like 'b1'"),
            to: tool.schema
                .union([tool.schema.number(), tool.schema.string()])
                .describe("Range end index from <compress-context-map>, or block reference like 'b1'"),
            summary: tool.schema
                .string()
                .describe("Complete technical summary replacing NEW content in this range"),
            topic: tool.schema
                .string()
                .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        },
        async execute(args, toolCtx) {
            const { client, stateManager, logger } = ctx
            const sessionId = toolCtx.sessionID
            const state = stateManager.get(sessionId)

            const outcome = await stateManager.runExclusive(sessionId, async () => {
                if (!state.persistenceSynchronized) {
                    throw new Error(
                        "compress cannot trust saved session state. Nothing was compressed. Call compress_map first inside the current management turn; if it cannot synchronize state, only the user can restart management with `/compress manage`.",
                    )
                }

                const snapshot = state.compressionMapSnapshot
                const latestIncompleteTurn = [...state.managementTurns]
                    .reverse()
                    .find((turn) => !turn.completedAt)
                const activeManagementTurn =
                    snapshot?.triggerMessageId === latestIncompleteTurn?.triggerMessageId
                        ? latestIncompleteTurn
                        : undefined
                if (!snapshot || !activeManagementTurn) {
                    throw new Error(
                        "compress has no authoritative map for the current management turn. Nothing was compressed. Call compress_map first and use labels from the map it returns. Outside a management turn, only the user can authorize one with `/compress manage`.",
                    )
                }

                const range = args as Partial<CompressRangeInput>
                if (typeof range !== "object" || !range) {
                    throw new Error("compress requires { from, to, summary, topic }")
                }
                if (!range.topic || typeof range.topic !== "string") {
                    throw new Error("compress requires a non-empty topic")
                }
                if (!range.summary || typeof range.summary !== "string") {
                    throw new Error("compress requires a non-empty summary")
                }
                if (
                    (typeof range.from !== "number" && typeof range.from !== "string") ||
                    (typeof range.to !== "number" && typeof range.to !== "string")
                ) {
                    throw new Error("compress requires valid from/to range boundaries")
                }

                const contextMap = contextMapFromCompressionSnapshot(snapshot)
                const baselineSummaries = [...state.compressSummaries]
                const baselineSummariesByAnchor = new Map(
                    baselineSummaries.map((summary) => [summary.anchorMessageId, summary]),
                )
                const missingBlock = contextMap.entries.find(
                    (entry) => {
                        if (entry.kind !== "block" || !entry.anchorMessageId) return false
                        const summary = baselineSummariesByAnchor.get(entry.anchorMessageId)
                        return (
                            !summary ||
                            summary.messageIds.length !== entry.rawMessageIds.length ||
                            summary.messageIds.some(
                                (messageId, index) => messageId !== entry.rawMessageIds[index],
                            )
                        )
                    },
                )
                if (missingBlock) {
                    throw new Error(
                        `The pinned map contains block [${String(missingBlock.key)}] without a matching durable summary. Nothing was compressed. Call compress_map again before retrying.`,
                    )
                }

                const resolvedRange = resolveContextMapRange(contextMap, range.from!, range.to!)
                if (
                    activeManagementTurn.source === "automatic" &&
                    resolvedRange.entries.some((entry) => entry.protected)
                ) {
                    throw new Error(
                        "Automatic compression cannot include entries labeled [protected active tail]. Nothing was compressed. Use an older unprotected range from the pinned map; do not guess a smaller or differently formatted boundary.",
                    )
                }
                const rangeMetrics = calculatePinnedCompressionRangeMetrics(resolvedRange)
                const containedMessageIds = rangeMetrics.messageIds
                if (containedMessageIds.length === 0) {
                    throw new Error("Could not resolve raw message IDs for the requested range")
                }

                const preservedSummaries = resolvedRange.entries
                    .filter(
                        (
                            entry,
                        ): entry is typeof entry & { kind: "block"; anchorMessageId: string } =>
                            entry.kind === "block" && typeof entry.anchorMessageId === "string",
                    )
                    .map((entry) => baselineSummariesByAnchor.get(entry.anchorMessageId)?.summary)
                    .filter(
                        (summary): summary is string =>
                            typeof summary === "string" && summary.length > 0,
                    )

                const finalSummary = selectFinalSummary(
                    preservedSummaries,
                    range.summary,
                    rangeMetrics.nonBlockMessageIds,
                )
                const containedToolIds = rangeMetrics.toolIds
                const allExistingBlocksArePinned = baselineSummaries.every((summary) =>
                    contextMap.entries.some(
                        (entry) =>
                            entry.kind === "block" &&
                            entry.anchorMessageId === summary.anchorMessageId,
                    ),
                )
                const pinnedBlockOrderIsSafe = contextMap.entries
                    .filter((entry) => entry.kind === "block")
                    .every((entry, index) => entry.key === `b${index}`)

                await toolCtx.ask({
                    permission: "compress",
                    patterns: ["*"],
                    always: ["*"],
                    metadata: {},
                })

                const startEntry = contextMap.entries[resolvedRange.startPosition]
                const anchorMessageId =
                    startEntry?.kind === "block" && startEntry.anchorMessageId
                        ? startEntry.anchorMessageId
                        : containedMessageIds[0]

                const candidateCompressed = {
                    toolIds: new Set(state.compressed.toolIds),
                    messageIds: new Set(state.compressed.messageIds),
                }
                for (const id of containedToolIds) {
                    candidateCompressed.toolIds.add(id)
                }
                for (const id of containedMessageIds) {
                    candidateCompressed.messageIds.add(id)
                }

                const candidateSummaries = removeSubsumedCompressSummaries(
                    state.compressSummaries,
                    containedMessageIds,
                )
                candidateSummaries.push({
                    anchorMessageId,
                    messageIds: containedMessageIds,
                    summary: finalSummary,
                    topic: range.topic,
                })

                const completedAt = new Date().toISOString()
                const candidateManagementTurns = state.managementTurns.map((turn) =>
                          turn === activeManagementTurn
                              ? {
                                    ...turn,
                                    completedAt,
                                    ...(typeof (toolCtx as any).callID === "string" &&
                                    (toolCtx as any).callID
                                        ? { completedCallId: (toolCtx as any).callID }
                                        : {}),
                                    completedMessageId: toolCtx.messageID,
                                }
                              : turn,
                      )

                const candidateStats = {
                    compressTokenCounter: 0,
                    totalCompressTokens:
                        state.stats.totalCompressTokens + rangeMetrics.incrementalCompressTokens,
                }

                const candidateState: SessionState = {
                    ...state,
                    compressed: candidateCompressed,
                    compressSummaries: candidateSummaries,
                    managementTurns: candidateManagementTurns,
                    stats: candidateStats,
                    compressionCooldownAfterMessageId: toolCtx.messageID,
                    compressionMapSnapshot: undefined,
                }

                const persisted = await saveSessionState(candidateState, logger)
                if (!persisted) {
                    throw new Error(
                        "compress could not persist compression state - the range was not compressed",
                    )
                }

                // Commit only now that the new state is durable, so a failed save leaves the
                // live in-memory state exactly as it was and no transform hides content as if
                // compression had succeeded.
                commitDurableSessionState(state, candidateState)

                return {
                    kind: "compressed" as const,
                    currentParams: {
                        providerId: state.modelContext?.providerId,
                        modelId: state.modelContext?.modelId,
                        agent: toolCtx.agent,
                        variant: state.variant,
                    },
                    containedToolIds,
                    mapEntryCount: rangeMetrics.mapEntryCount,
                    topic: range.topic,
                    finalSummary,
                    startPosition: resolvedRange.startPosition,
                    endPosition: resolvedRange.endPosition,
                    contextMapEntryCount: contextMap.entries.length,
                    estimatedCompressedTokens: rangeMetrics.estimatedCompressedTokens,
                    anchorMessageId,
                    storedBlockId: allExistingBlocksArePinned && pinnedBlockOrderIsSafe
                        ? `b${contextMap.entries
                              .slice(0, resolvedRange.startPosition)
                              .filter((entry) => entry.kind === "block").length}`
                        : undefined,
                    continueTask: activeManagementTurn.source === "automatic",
                }
            })

            await sendCompressNotification(
                client,
                logger,
                ctx.config,
                state,
                sessionId,
                outcome.containedToolIds,
                outcome.mapEntryCount,
                outcome.topic,
                outcome.finalSummary,
                { messageIndex: outcome.startPosition },
                { messageIndex: outcome.endPosition },
                outcome.contextMapEntryCount,
                outcome.currentParams,
                outcome.estimatedCompressedTokens,
            )

            return buildCompressReceipt(
                outcome.topic,
                outcome.storedBlockId,
                outcome.continueTask,
            )
        },
    })
}
