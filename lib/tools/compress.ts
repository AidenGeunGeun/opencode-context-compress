import { tool } from "@opencode-ai/plugin"
import type { WithParts, CompressSummary } from "../state"
import type { CompressToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { loadPrompt } from "../prompts"
import { estimateTokensBatch, getCurrentParams } from "../token-utils"
import { collectContentInRange, collectToolIdsInRange } from "./utils"
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
    return summaries.filter((summary) => !containedIds.has(summary.anchorMessageId))
}

export function composeSummaryWithPreservedBlocks(
    preservedSummaries: string[],
    newSummary: string,
): string {
    if (preservedSummaries.length === 0) {
        return newSummary.trim()
    }

    return [
        "[Preserved from previous compression]",
        ...preservedSummaries,
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

export function createCompressTool(ctx: CompressToolContext): ReturnType<typeof tool> {
    return tool({
        description: COMPRESS_TOOL_DESCRIPTION,
        args: {
            ranges: tool.schema
                .array(
                    tool.schema.object({
                        from: tool.schema
                            .union([tool.schema.number(), tool.schema.string()])
                            .describe(
                                "Range start index from <compress-context-map>, or block reference like 'b1'",
                            ),
                        to: tool.schema
                            .union([tool.schema.number(), tool.schema.string()])
                            .describe(
                                "Range end index from <compress-context-map>, or block reference like 'b1'",
                            ),
                        summary: tool.schema
                            .string()
                            .describe("Complete technical summary replacing NEW content in this range"),
                        topic: tool.schema
                            .string()
                            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
                    }),
                )
                .describe("One or more compression ranges to process in this call"),
        },
        async execute(args, toolCtx) {
            const { client, state, logger } = ctx
            const sessionId = toolCtx.sessionID

            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

            const ranges = Array.isArray(args.ranges) ? (args.ranges as CompressRangeInput[]) : []
            if (ranges.length === 0) {
                throw new Error("ranges is required and must contain at least one compression range")
            }

            const messagesResponse = await client.session.messages({
                path: { id: sessionId },
            })
            const rawMessages: WithParts[] = messagesResponse.data || messagesResponse

            await ensureSessionInitialized(client, state, sessionId, logger, rawMessages)

            const currentParams = getCurrentParams(state, rawMessages, logger)
            const contextMap = buildContextMap(rawMessages, state, logger, currentParams.providerId)
            const baselineSummaries = [...state.compressSummaries]
            const rawMessageIndexById = new Map(rawMessages.map((message, index) => [message.info.id, index]))

            let totalEntriesCompressed = 0
            let totalToolCallsCompressed = 0

            for (const range of ranges) {
                if (!range || typeof range !== "object") {
                    throw new Error("Each range entry must be an object")
                }
                if (!range.topic || typeof range.topic !== "string") {
                    throw new Error("Each range requires a non-empty topic")
                }
                if (!range.summary || typeof range.summary !== "string") {
                    throw new Error("Each range requires a non-empty summary")
                }

                const resolvedRange = resolveContextMapRange(contextMap, range.from, range.to)
                const rangeMetrics = calculateCompressionRangeMetrics(
                    rawMessages,
                    rawMessageIndexById,
                    resolvedRange,
                    currentParams.providerId,
                )
                const containedMessageIds = rangeMetrics.messageIds
                if (containedMessageIds.length === 0) {
                    throw new Error("Could not resolve raw message IDs for one of the requested ranges")
                }

                const preservedSummaries = resolvedRange.blockIds
                    .map((blockId) => {
                        const blockIndex = Number(blockId.slice(1))
                        return baselineSummaries[blockIndex]?.summary
                    })
                    .filter((summary): summary is string => typeof summary === "string" && summary.length > 0)

                const finalSummary = composeSummaryWithPreservedBlocks(preservedSummaries, range.summary)
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
                    typeof startEntry?.key === "string" && /^b\d+$/.test(startEntry.key)
                        ? baselineSummaries[Number(startEntry.key.slice(1))]?.anchorMessageId ||
                          containedMessageIds[0]
                        : containedMessageIds[0]

                state.compressSummaries.push({
                    anchorMessageId,
                    messageIds: containedMessageIds,
                    summary: finalSummary,
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

                totalEntriesCompressed += rangeMetrics.mapEntryCount
                totalToolCallsCompressed += containedToolIds.length
            }

            saveSessionState(state, logger).catch((err) =>
                logger.error("Failed to persist state", { error: err.message }),
            )

            return `Compressed ${ranges.length} ranges (${totalEntriesCompressed} entries, ${totalToolCallsCompressed} tool calls) into summaries.`
        },
    })
}
