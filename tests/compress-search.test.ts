import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { transformMessagesForSearch } from "../lib/messages/compress-transform.ts"
import type { CompressSummary, SessionState, WithParts } from "../lib/state/types.ts"
import { isolateHostDirs, partText } from "./helpers.ts"

const root = await isolateHostDirs()
const { loadSessionState } = await import("../lib/state/persistence.ts")
const { Logger } = await import("../lib/logger.ts")
after(() => rm(root, { recursive: true, force: true }))

const textMessage = (id: string, text: string, role: "user" | "assistant" = "user"): WithParts => ({
    info: {
        id,
        role,
        sessionID: "session-test",
        agent: "agent-test",
        model: { providerID: "provider-test", modelID: "model-test" },
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
    persistenceSynchronized: true,
    hasPersistedState: false,
    persistedLastUpdated: null,
    compressed: {
        toolIds: new Set<string>(),
        messageIds: new Set<string>(compressedMessageIds),
    },
    compressSummaries: summaries,
    managementTurns: [],
    lastCompaction: 0,
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
        const { transformed, syntheticMap } = transformMessagesForSearch(rawMessages, state)

        assert.deepEqual(
            transformed.map((message) => [message.info.role, ...message.parts.map(partText)]),
            [
                ["user", "alpha start"],
                [
                    "user",
                    "[Compressed conversation block]\n\n[b0]\n\nlegacy block summary with needle",
                ],
            ],
        )
        assert.equal(syntheticMap.size, 1)
    })
})

describe("compress summary maintenance", () => {
    it("renders older saved summaries without messageIds through the persistence consumer", async () => {
        const messages = [
            textMessage("m1", "pre"),
            textMessage("m2", "start"),
            textMessage("m3", "middle"),
            textMessage("m4", "end"),
            textMessage("m5", "post"),
        ]

        const storage = join(root, "data", "opencode", "storage", "plugin", "compress")
        await mkdir(storage, { recursive: true })
        await writeFile(
            join(storage, "session-test.json"),
            JSON.stringify({
                compressed: { toolIds: [], messageIds: ["m2", "m3", "m4"] },
                compressSummaries: [{ anchorMessageId: "m2", summary: "legacy" }],
                lastUpdated: "2026-01-01T00:00:00.000Z",
            }),
        )
        const loaded = await loadSessionState(
            "session-test",
            new Logger({ daily: false, context: false }),
            messages,
        )
        assert.equal(loaded.status, "loaded")
        assert.deepEqual(loaded.state.compressSummaries, [
            { anchorMessageId: "m2", messageIds: ["m2", "m3", "m4"], summary: "legacy" },
        ])
        const state = createState(
            loaded.state.compressed.messageIds,
            loaded.state.compressSummaries,
        )
        const { transformed } = transformMessagesForSearch(messages, state)
        assert.deepEqual(
            transformed.map((message) => message.parts.map(partText)),
            [["pre"], ["[Compressed conversation block]\n\n[b0]\n\nlegacy"], ["post"]],
        )
    })
})
