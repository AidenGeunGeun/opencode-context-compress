import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { buildContextMap } from "../lib/messages/context-map.ts"
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
    initialized: true,
    isSubAgent: false,
    hasPersistedState: false,
    persistedLastUpdated: null,
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

describe("buildContextMap", () => {
    it("builds map text and lookup entries for grouped assistant ranges", () => {
        const rawMessages = [
            textMessage("m1", "Let's plan auth"),
            toolMessage("m2", "read", "read output"),
            toolMessage("m3", "bash", "bash output"),
            textMessage("m4", "Looks good, implement it"),
            textMessage("m5", "Implemented", "assistant"),
        ]
        const state = createState()

        const result = buildContextMap(rawMessages as any, state, logger)

        assert.match(result.mapText, /<compress-context-map>/)
        assert.match(result.mapText, /\[1\] user:/)
        assert.match(result.mapText, /\[2-3\] assistant: 2 tool calls -/)
        assert.doesNotMatch(result.mapText, /\(read, bash\)/)
        assert.doesNotMatch(result.mapText, /Active:/)
        assert.match(result.mapText, /Total: 5 messages \+ 0 blocks/)

        assert.deepEqual(result.lookup.get(1), ["m1"])
        assert.deepEqual(result.lookup.get(2), ["m2"])
        assert.deepEqual(result.lookup.get(3), ["m3"])
        assert.deepEqual(result.lookup.get("2-3"), ["m2", "m3"])
    })

    it("includes compressed blocks as bN entries and maps them to raw IDs", () => {
        const summary: CompressSummary = {
            anchorMessageId: "m2",
            messageIds: ["m2", "m3"],
            summary: "Database schema exploration and migration setup",
        }

        const rawMessages = [
            textMessage("m1", "before block"),
            textMessage("m2", "hidden old message", "assistant"),
            textMessage("m3", "hidden old message 2", "assistant"),
            textMessage("m4", "after block"),
        ]
        const state = createState(["m2", "m3"], [summary])

        const result = buildContextMap(rawMessages as any, state, logger)

        assert.match(result.mapText, /\[b0\] \[compressed\]/)
        assert.doesNotMatch(result.mapText, /Active:/)
        assert.deepEqual(result.lookup.get("b0"), ["m2", "m3"])
        assert.deepEqual(result.lookup.get(1), ["m1"])
        assert.deepEqual(result.lookup.get(2), ["m4"])
    })

    it("assigns bN labels by anchor position instead of summary array order", () => {
        const earlySummary: CompressSummary = {
            anchorMessageId: "m1",
            messageIds: ["m1", "m2"],
            summary: "Early block summary",
            topic: "Early Block",
        }
        const middleSummary: CompressSummary = {
            anchorMessageId: "m3",
            messageIds: ["m3", "m4"],
            summary: "Middle block summary",
            topic: "Middle Block",
        }
        const lateSummary: CompressSummary = {
            anchorMessageId: "m5",
            messageIds: ["m5", "m6"],
            summary: "Late block summary",
            topic: "Late Block",
        }

        const rawMessages = [
            textMessage("m1", "early request"),
            textMessage("m2", "early result", "assistant"),
            textMessage("m3", "middle request"),
            textMessage("m4", "middle result", "assistant"),
            textMessage("m5", "late request"),
            textMessage("m6", "late result", "assistant"),
            textMessage("m7", "active tail"),
        ]
        const state = createState(
            ["m1", "m2", "m3", "m4", "m5", "m6"],
            [middleSummary, lateSummary, earlySummary],
        )

        const result = buildContextMap(rawMessages as any, state, logger)

        assert.match(
            result.mapText,
            /\[b0\] \[compressed\] "Early Block"[\s\S]*\[b1\] \[compressed\] "Middle Block"[\s\S]*\[b2\] \[compressed\] "Late Block"/,
        )
        assert.deepEqual(result.lookup.get("b0"), ["m1", "m2"])
        assert.deepEqual(result.lookup.get("b1"), ["m3", "m4"])
        assert.deepEqual(result.lookup.get("b2"), ["m5", "m6"])
    })
})
