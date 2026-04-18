import { tool } from "@opencode-ai/plugin"
import type { WithParts, CompressSummary } from "../state"
import type { CompressToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { loadPrompt } from "../prompts"
import { estimateTokensBatch, getCurrentParams } from "../token-utils"
import {
    collectContentInRange,
    collectToolIdsInRange,
} from "./utils"
import { sendCompressNotification } from "../ui/notification"
import {
    buildContextMap,
    resolveContextMapRange,
    type ResolvedContextMapRange,
} from "../messages/context-map"

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

            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

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

            const messagesResponse = await client.session.messages({
                path: { id: sessionId },
            })
            const rawMessages: WithParts[] = messagesResponse.data || messagesResponse

            await ensureSessionInitialized(client, state, sessionId, logger, rawMessages)

            const currentParams = getCurrentParams(state, rawMessages, logger)
            const contextMap = buildContextMap(rawMessages, state, logger, currentParams.providerId)
            const baselineSummaries = [...state.compressSummaries]
            const baselineSummariesByAnchor = new Map(
                baselineSummaries.map((summary) => [summary.anchorMessageId, summary]),
            )
            const rawMessageIndexById = new Map(rawMessages.map((message, index) => [message.info.id, index]))

            const resolvedRange = resolveContextMapRange(contextMap, range.from!, range.to!)
            const rangeMetrics = calculateCompressionRangeMetrics(
                rawMessages,
                rawMessageIndexById,
                resolvedRange,
                currentParams.providerId,
            )
            const containedMessageIds = rangeMetrics.messageIds
            if (containedMessageIds.length === 0) {
                throw new Error("Could not resolve raw message IDs for the requested range")
            }

            const preservedSummaries = resolvedRange.entries
                .filter(
                    (entry): entry is typeof entry & { kind: "block"; anchorMessageId: string } =>
                        entry.kind === "block" && typeof entry.anchorMessageId === "string",
                )
                .map((entry) => baselineSummariesByAnchor.get(entry.anchorMessageId)?.summary)
                .filter((summary): summary is string => typeof summary === "string" && summary.length > 0)

            const finalSummary = selectFinalSummary(
                preservedSummaries,
                range.summary,
                rangeMetrics.nonBlockMessageIds,
            )
            const containedToolIds = rangeMetrics.toolIds

            for (const id of containedToolIds) {
                state.compressed.toolIds.add(id)
            }
            for (const id of containedMessageIds) {
                state.compressed.messageIds.add(id)
            }

            state.compressSummaries = removeSubsumedCompressSummaries(
                state.compressSummaries,
                containedMessageIds,
            )

            const startEntry = contextMap.entries[resolvedRange.startPosition]
            const anchorMessageId =
                startEntry?.kind === "block" && startEntry.anchorMessageId
                    ? startEntry.anchorMessageId
                    : containedMessageIds[0]

            state.compressSummaries.push({
                anchorMessageId,
                messageIds: containedMessageIds,
                summary: finalSummary,
                topic: range.topic,
            })

            state.stats.compressTokenCounter = rangeMetrics.incrementalCompressTokens

            await sendCompressNotification(
                client,
                logger,
                ctx.config,
                state,
                sessionId,
                containedToolIds,
                rangeMetrics.mapEntryCount,
                range.topic,
                finalSummary,
                { messageIndex: resolvedRange.startPosition },
                { messageIndex: resolvedRange.endPosition },
                contextMap.entries.length,
                currentParams,
                rangeMetrics.estimatedCompressedTokens,
            )

            state.stats.totalCompressTokens += rangeMetrics.incrementalCompressTokens
            state.stats.compressTokenCounter = 0

            try {
                await saveSessionState(state, logger)
            } catch (err: any) {
                logger.error("Failed to persist state", { error: err.message })
            }

            const updatedContextMap = buildContextMap(rawMessages, state, logger, currentParams.providerId)

            return [
                `Compressed range (${rangeMetrics.mapEntryCount} entries, ${containedToolIds.length} tool calls) into summary.`,
                updatedContextMap.mapText,
            ].join("\n\n")
        },
    })
}
