import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { COMPRESS_SUMMARY_PREFIX } from "../lib/messages/utils.ts"
import { transformMessagesForSearch } from "../lib/messages/compress-transform.ts"
import { removeSubsumedCompressSummaries } from "../lib/tools/compress.ts"
import { backfillCompressSummaryMessageIds } from "../lib/state/persistence.ts"
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

const createState = (
    compressedMessageIds: string[] = [],
    summaries: CompressSummary[] = [],
): SessionState => ({
    sessionId: "session-test",
    initialized: true,
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

describe("compressed message transformation", () => {
    it("injects synthetic summary message when a compressed block exists", () => {
        const rawMessages = [
            textMessage("m1", "alpha start"),
            textMessage("m2", "hidden block one"),
            textMessage("m3", "gamma tail"),
        ]
        const summary: CompressSummary = {
            anchorMessageId: "m2",
            messageIds: ["m2", "m3"],
            summary: "legacy block summary with needle",
        }
        const state = createState(["m2", "m3"], [summary])
        const { transformed, syntheticMap } = transformMessagesForSearch(rawMessages as any, state, logger)

        assert.equal(transformed.length, 2)
        assert.equal(syntheticMap.size, 1)
        assert.equal(transformed[0].info.id, "m1")
        assert.equal((transformed[1] as any).parts[0].text.startsWith(COMPRESS_SUMMARY_PREFIX), true)
    })

    it("subsumes old summary when new range includes its anchor", () => {
        const summaryInRange: CompressSummary = {
            anchorMessageId: "m2",
            messageIds: ["m2", "m3"],
            summary: "legacy block summary",
        }
        const summaryOutsideRange: CompressSummary = {
            anchorMessageId: "m8",
            messageIds: ["m8"],
            summary: "keep me",
        }

        const result = removeSubsumedCompressSummaries(
            [summaryInRange, summaryOutsideRange],
            ["m1", "m2", "m3", "m4"],
        )

        assert.equal(result.length, 1)
        assert.equal(result[0].anchorMessageId, "m8")
    })
})

describe("compress summary maintenance", () => {
    it("backfills missing messageIds from anchor and compressed message run", () => {
        const summaries = [{ anchorMessageId: "m2", summary: "legacy" }] as CompressSummary[]
        const messages = [
            textMessage("m1", "pre"),
            textMessage("m2", "start"),
            textMessage("m3", "middle"),
            textMessage("m4", "end"),
            textMessage("m5", "post"),
        ]

        const result = backfillCompressSummaryMessageIds(
            summaries,
            messages as any,
            new Set(["m2", "m3", "m4"]),
        )

        assert.deepEqual(result[0].messageIds, ["m2", "m3", "m4"])
    })
})
