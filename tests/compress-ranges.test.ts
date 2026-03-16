import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { buildContextMap, resolveContextMapRange } from "../lib/messages/context-map.ts"
import { estimateTokensBatch, countTokens } from "../lib/token-utils.ts"
import { collectContentInRange } from "../lib/tools/utils.ts"
import {
    composeSummaryWithPreservedBlocks,
    calculateCompressionRangeMetrics,
} from "../lib/tools/compress.ts"
import type { CompressSummary, SessionState } from "../lib/state/types.ts"

const logger = {
    info: () => {},
    warn: () => {},
} as any

const textMessage = (id: string, text: string, role: "user" | "assistant" = "user") => ({
    info: {
        id,
        role,
        sessionID: "session-test",
        agent: "agent-test",
        model: "model-test",
        time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
})

const toolMessage = (id: string, tool: string, output: string) => ({
    info: {
        id,
        role: "assistant" as const,
        sessionID: "session-test",
        agent: "agent-test",
        model: "model-test",
        time: { created: Date.now() },
    },
    parts: [
        {
            type: "tool",
            tool,
            callID: `call-${id}`,
            state: {
                status: "completed",
                input: { description: `${tool} call` },
                output,
            },
        },
    ],
})

const createState = (
    compressedMessageIds: string[] = [],
    summaries: CompressSummary[] = [],
): SessionState => ({
    sessionId: "session-test",
    isSubAgent: false,
    compressed: {
        toolIds: new Set<string>(),
        messageIds: new Set<string>(compressedMessageIds),
    },
    compressSummaries: summaries,
    stats: {
        compressTokenCounter: 0,
        totalCompressTokens: 0,
    },
    toolParameters: new Map(),
    toolIdList: [],
    lastCompaction: 0,
    currentTurn: 0,
    variant: undefined,
})

describe("resolveContextMapRange", () => {
    it("includes compressed blocks encountered between numeric endpoints", () => {
        const summary: CompressSummary = {
            anchorMessageId: "m2",
            messageIds: ["m2", "m3"],
            summary: "legacy block summary",
        }
        const rawMessages = [
            textMessage("m1", "before block"),
            textMessage("m2", "old 1", "assistant"),
            textMessage("m3", "old 2", "assistant"),
            textMessage("m4", "after block"),
            textMessage("m5", "tail"),
        ]
        const state = createState(["m2", "m3"], [summary])

        const contextMap = buildContextMap(rawMessages as any, state, logger)
        const resolved = resolveContextMapRange(contextMap, 1, 2)

        assert.deepEqual(resolved.messageIds, ["m1", "m2", "m3", "m4"])
        assert.deepEqual(resolved.nonBlockMessageIds, ["m1", "m4"])
        assert.deepEqual(resolved.blockIds, ["b0"])
        assert.equal(resolved.mapEntryCount, 3)
        assert.equal(resolved.startPosition <= resolved.endPosition, true)
    })

    it("resolves multiple independent ranges from one snapshot", () => {
        const rawMessages = [
            textMessage("m1", "start A"),
            textMessage("m2", "assistant A", "assistant"),
            textMessage("m3", "start B"),
            textMessage("m4", "assistant B", "assistant"),
        ]
        const state = createState()
        const contextMap = buildContextMap(rawMessages as any, state, logger)

        const first = resolveContextMapRange(contextMap, 1, 2)
        const second = resolveContextMapRange(contextMap, 3, 4)

        assert.deepEqual(first.messageIds, ["m1", "m2"])
        assert.deepEqual(second.messageIds, ["m3", "m4"])
    })

    it("accepts grouped range labels emitted by the context map", () => {
        const rawMessages = [
            textMessage("m1", "start"),
            textMessage("m2", "assistant one", "assistant"),
            textMessage("m3", "assistant two", "assistant"),
            textMessage("m4", "end"),
        ]
        const state = createState()
        const contextMap = buildContextMap(rawMessages as any, state, logger)

        const resolved = resolveContextMapRange(contextMap, "2-3", "4")

        assert.deepEqual(resolved.messageIds, ["m2", "m3", "m4"])
    })
})

describe("composeSummaryWithPreservedBlocks", () => {
    it("prepends preserved summaries and appends new content summary", () => {
        const result = composeSummaryWithPreservedBlocks(["old summary one", "old summary two"], "new summary")

        assert.match(result, /^\[Preserved from previous compression\]/)
        assert.match(result, /old summary one/)
        assert.match(result, /old summary two/)
        assert.match(result, /\[New content\]/)
        assert.match(result, /new summary$/)
    })
})

describe("calculateCompressionRangeMetrics", () => {
    it("uses block summary token estimates and counts tools from non-block messages only", () => {
        const summary: CompressSummary = {
            anchorMessageId: "m2",
            messageIds: ["m2", "m3"],
            summary: "compressed exploration from previous run",
        }
        const rawMessages = [
            textMessage("m1", "before compressed block"),
            toolMessage("m2", "read", "old read output"),
            textMessage("m3", "old assistant detail", "assistant"),
            toolMessage("m4", "bash", "new bash output"),
        ]
        const state = createState(["m2", "m3"], [summary])
        const contextMap = buildContextMap(rawMessages as any, state, logger)
        const resolved = resolveContextMapRange(contextMap, 1, 2)
        const rawMessageIndexById = new Map(rawMessages.map((message, index) => [message.info.id, index]))

        const metrics = calculateCompressionRangeMetrics(
            rawMessages as any,
            rawMessageIndexById,
            resolved,
        )

        const nonBlockMessages = [rawMessages[0], rawMessages[3]]
        const expectedNonBlockTokens = estimateTokensBatch(
            collectContentInRange(nonBlockMessages as any, 0, nonBlockMessages.length - 1),
        )
        const expectedBlockTokens = countTokens(summary.summary)

        assert.equal(metrics.mapEntryCount, 3)
        assert.deepEqual(metrics.messageIds, ["m1", "m2", "m3", "m4"])
        assert.deepEqual(metrics.nonBlockMessageIds, ["m1", "m4"])
        assert.deepEqual(metrics.toolIds, ["call-m4"])
        assert.equal(metrics.blockTokenEstimate, expectedBlockTokens)
        assert.equal(metrics.nonBlockTokenEstimate, expectedNonBlockTokens)
        assert.equal(metrics.estimatedCompressedTokens, expectedBlockTokens + expectedNonBlockTokens)
        assert.equal(metrics.incrementalCompressTokens, expectedNonBlockTokens)
    })

    it("keeps cumulative token savings incremental across repeated compression", () => {
        const firstCompressionMessages = [
            textMessage("m1", "first pass content"),
            toolMessage("m2", "read", "first pass tool output"),
        ]
        const firstState = createState()
        const firstMap = buildContextMap(firstCompressionMessages as any, firstState, logger)
        const firstRange = resolveContextMapRange(firstMap, 1, 2)
        const firstIndexById = new Map(
            firstCompressionMessages.map((message, index) => [message.info.id, index]),
        )
        const firstMetrics = calculateCompressionRangeMetrics(
            firstCompressionMessages as any,
            firstIndexById,
            firstRange,
        )

        const summary: CompressSummary = {
            anchorMessageId: "m1",
            messageIds: ["m1", "m2"],
            summary: "first pass compressed summary",
        }
        const secondCompressionMessages = [
            ...firstCompressionMessages,
            toolMessage("m3", "bash", "second pass tool output"),
        ]
        const secondState = createState(["m1", "m2"], [summary])
        const secondMap = buildContextMap(secondCompressionMessages as any, secondState, logger)
        const secondRange = resolveContextMapRange(secondMap, "b0", 1)
        const secondIndexById = new Map(
            secondCompressionMessages.map((message, index) => [message.info.id, index]),
        )
        const secondMetrics = calculateCompressionRangeMetrics(
            secondCompressionMessages as any,
            secondIndexById,
            secondRange,
        )

        const cumulative = firstMetrics.incrementalCompressTokens + secondMetrics.incrementalCompressTokens
        const secondNewOnlyTokens = estimateTokensBatch(
            collectContentInRange([secondCompressionMessages[2]] as any, 0, 0),
        )

        assert.equal(firstMetrics.incrementalCompressTokens, firstMetrics.estimatedCompressedTokens)
        assert.equal(secondMetrics.blockTokenEstimate, countTokens(summary.summary))
        assert.equal(secondMetrics.incrementalCompressTokens, secondNewOnlyTokens)
        assert.equal(cumulative, firstMetrics.estimatedCompressedTokens + secondNewOnlyTokens)
    })
})
