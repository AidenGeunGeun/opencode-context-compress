import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"

import type { WithParts } from "../lib/state/types.ts"
import { isolateHostDirs, modelRequest, modelText, startContextHook } from "./helpers.ts"

const root = await isolateHostDirs()
const { Logger } = await import("../lib/logger.ts")
const { COMPRESS_SUMMARY_PREFIX } = await import("../lib/messages/utils.ts")
const { setup } = await import("../lib/plugin.ts")
const { saveSessionState } = await import("../lib/state/persistence.ts")
const { SessionStateManager } = await import("../lib/state/state.ts")
after(() => rm(root, { recursive: true, force: true }))

const logger = new Logger({ daily: false, context: false })

const createMessage = (id: string, sessionID: string, role: "user" | "assistant"): WithParts => ({
    info: {
        id,
        role,
        sessionID,
        agent: "agent-test",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        time: { created: Date.now() },
    },
    parts: [{ type: "text", text: `message-${id}` }],
})

// Runs a fresh plugin instance's context hook on the model request built from the transcript.
const startInstance = async (transcript: WithParts[]) => {
    const context = await startContextHook(setup, root, { context: async () => transcript })
    return async (sessionId: string) => {
        const messages = modelRequest(transcript)
        await context(sessionId, messages)
        return messages
    }
}

const isSummary = (text: string) => text.startsWith(COMPRESS_SUMMARY_PREFIX)

describe("session-scoped compress overlay", () => {
    it("reloads persisted compression state for a stale second instance", async () => {
        const sessionId = "session-overlay"
        const rawMessages = [
            createMessage("m1", sessionId, "user"),
            createMessage("m2", sessionId, "assistant"),
            createMessage("m3", sessionId, "assistant"),
        ]
        const runB = await startInstance(rawMessages)

        const first = await runB(sessionId)
        assert.deepEqual(
            first.map((message) => message.id),
            ["m1", "m2", "m3"],
        )

        const stateA = new SessionStateManager().get(sessionId)
        stateA.compressed.messageIds = new Set(["m2", "m3"])
        stateA.compressSummaries = [
            {
                anchorMessageId: "m2",
                messageIds: ["m2", "m3"],
                summary: "compressed block summary",
            },
        ]
        await saveSessionState(stateA, logger)

        const second = await runB(sessionId)
        assert.equal(second.length, 2)
        assert.equal(second[0].id, "m1")
        assert.equal(isSummary(modelText(second[1])), true)
    })

    it("hydrates multiple persisted summaries after instance recreation", async () => {
        const sessionId = "session-overlay-multi"
        const rawMessages = [
            createMessage("m1", sessionId, "user"),
            createMessage("m2", sessionId, "assistant"),
            createMessage("m3", sessionId, "assistant"),
            createMessage("m4", sessionId, "user"),
            createMessage("m5", sessionId, "assistant"),
            createMessage("m6", sessionId, "assistant"),
        ]
        const stateA = new SessionStateManager().get(sessionId)
        stateA.compressed.messageIds = new Set(["m2", "m3", "m5", "m6"])
        stateA.compressSummaries = [
            { anchorMessageId: "m2", messageIds: ["m2", "m3"], summary: "first block" },
            { anchorMessageId: "m5", messageIds: ["m5", "m6"], summary: "second block" },
        ]
        await saveSessionState(stateA, logger)

        const messages = await (await startInstance(rawMessages))(sessionId)

        assert.equal(messages.filter((message) => isSummary(modelText(message))).length, 2)
        assert.deepEqual(
            messages.map((message) => message.role),
            ["user", "user", "user", "user"],
        )
    })

    it("leaves sessions without persisted compression unchanged", async () => {
        const sessionId = "session-overlay-empty"
        const rawMessages = [
            createMessage("m1", sessionId, "user"),
            createMessage("m2", sessionId, "assistant"),
        ]

        const messages = await (await startInstance(rawMessages))(sessionId)

        assert.deepEqual(messages, modelRequest(rawMessages))
    })
})
