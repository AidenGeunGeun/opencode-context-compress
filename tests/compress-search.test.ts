import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { COMPRESS_SUMMARY_PREFIX } from "../lib/messages/utils.ts"
import { transformMessagesForSearch } from "../lib/messages/compress-transform.ts"
import { selectDeterministicCompressionSpan } from "../lib/messages/context-map.ts"
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
    hasPersistedState: false,
    persistedLastUpdated: null,
    compressed: {
        toolIds: new Set<string>(),
        messageIds: new Set<string>(compressedMessageIds),
    },
    compressSummaries: summaries,
    managementTurns: [],
    stats: {
        compressTokenCounter: 0,
        totalCompressTokens: 0,
    },
    lastCompaction: 0,
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
        const { transformed, syntheticMap } = transformMessagesForSearch(
            rawMessages as any,
            state,
            logger,
        )

        assert.equal(transformed.length, 2)
        assert.equal(syntheticMap.size, 1)
        assert.equal(transformed[0].info.id, "m1")
        assert.equal(
            (transformed[1] as any).parts[0].text.startsWith(COMPRESS_SUMMARY_PREFIX),
            true,
        )
    })

    it("excludes Version 2 machinery from a future summary without dropping other parts", () => {
        const state = createState()
        state.managementTurns = [
            {
                triggerMessageId: "manage-v2",
                cleanupVersion: 2,
                completedAt: new Date().toISOString(),
                completedMessageId: "compress-v2",
            },
        ]
        const completion = textMessage(
            "compress-v2",
            "reasoning before compression",
            "assistant",
        ) as any
        completion.parts.push({
            type: "tool",
            tool: "compress",
            callID: "call-v2",
            state: { status: "completed" },
        })
        completion.parts.push({ type: "text", text: "work after compression" })
        const rawMessages = [
            textMessage("before-v2", "before"),
            textMessage("manage-v2", "CONTEXT MANAGEMENT REQUESTED"),
            completion,
            textMessage("after-v2", "continued work", "assistant"),
            textMessage("user-v2", "next request"),
        ]

        const span = selectDeterministicCompressionSpan(rawMessages as any, state, logger, 0)

        assert.deepEqual(span.messageIds, ["before-v2", "compress-v2", "after-v2", "user-v2"])
        assert.equal(
            span.messages
                .flatMap((message) => message.parts)
                .some((part: any) => part.tool === "compress"),
            false,
        )
        assert.match(
            JSON.stringify(span.messages),
            /reasoning before compression|work after compression|continued work/,
        )
        assert.doesNotMatch(JSON.stringify(span.messages), /CONTEXT MANAGEMENT REQUESTED/)
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
