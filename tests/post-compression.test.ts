import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"

import type { ManagementTurn, Part, SessionState, WithParts } from "../lib/state/types.ts"
import { isolateHostDirs, modelRequest, startContextHook } from "./helpers.ts"

const root = await isolateHostDirs()
const { Logger } = await import("../lib/logger.ts")
const { setup } = await import("../lib/plugin.ts")
const { saveSessionState } = await import("../lib/state/persistence.ts")
const { createSessionState } = await import("../lib/state/state.ts")
after(() => rm(root, { recursive: true, force: true }))

const logger = new Logger({ daily: false, context: false })
let time = 1_800_000_000_000

const message = (id: string, role: "user" | "assistant", parts: Part[]): WithParts => ({
    info: {
        id,
        role,
        sessionID: "s",
        agent: "build",
        ...(role === "user" ? { model: { providerID: "openai", modelID: "gpt-test" } } : {}),
        time: { created: time++, ...(role === "assistant" ? { completed: time++ } : {}) },
    } as WithParts["info"],
    parts: parts.map((part, index) => ({
        id: `part-${id}-${index}`,
        sessionID: "s",
        messageID: id,
        ...part,
    })),
})

const text = (text: string): Part => ({ type: "text", text })

const compressTurn: ManagementTurn = {
    triggerMessageId: "trigger",
    cleanupVersion: 2,
    source: "automatic",
    completedAt: new Date(time).toISOString(),
    completedMessageId: "compress-step",
}

// An automatic compress folded the old exchange; its trigger and receipt are the newest messages.
const folded = [
    message("old-user", "user", [text("Old request")]),
    message("old-answer", "assistant", [text("Old answer")]),
    message("task", "user", [text("Do the work")]),
    message("work", "assistant", [text("Working")]),
    message("trigger", "user", [text("<system-reminder>compress</system-reminder>")]),
    message("compress-step", "assistant", [
        {
            type: "tool",
            tool: "compress",
            callID: "call-compress",
            state: {
                status: "completed",
                input: { summary: "Earlier work.", topic: "Earlier Work" },
                output: "Automatic context compression finished.",
            },
        },
    ]),
]

/** Starts the plugin on a session with the fold above and returns the model request per transcript. */
const startSession = async (sessionID: string, managementTurns: ManagementTurn[]) => {
    const durable: Partial<SessionState> = {
        compressed: { toolIds: new Set(), messageIds: new Set(["old-user", "old-answer"]) },
        compressSummaries: [
            {
                anchorMessageId: "old-user",
                messageIds: ["old-user", "old-answer"],
                summary: "Earlier work.",
                topic: "Earlier Work",
            },
        ],
        managementTurns,
        compressionCooldownAfterMessageId: "compress-step",
    }
    await saveSessionState({ ...createSessionState(), sessionId: sessionID, ...durable }, logger)
    let transcript: WithParts[] = []
    const context = await startContextHook(setup, root, { context: async () => transcript })
    return async (next: WithParts[]) => {
        transcript = next
        const request = modelRequest(next)
        await context(sessionID, request)
        return request
    }
}

describe("after a compression", () => {
    it("adds nothing to the request, so the next request extends it and the cache holds", async () => {
        const run = await startSession("post-compression-append", [compressTurn])

        const first = await run(folded)
        const second = await run([...folded, message("resumed", "assistant", [text("Resuming")])])

        assert.equal(first.at(-1)?.id, "compress-step")
        assert.deepEqual(second.slice(0, first.length), first)
        assert.equal(second.length, first.length + 1)
    })

    it("keeps the compress receipt when the agent leaves an automatic squash unanswered", async () => {
        const run = await startSession("post-compression-squash-ignored", [
            compressTurn,
            {
                triggerMessageId: "squash-trigger",
                cleanupVersion: 2,
                source: "squash",
                triggeredByMessageId: "compress-step",
                completedAt: new Date(time).toISOString(),
                completedMessageId: "ignored-step",
            },
        ])

        const request = await run([
            ...folded,
            message("squash-trigger", "user", [text("<system-reminder>squash</system-reminder>")]),
            message("ignored-step", "assistant", [text("Continuing the task")]),
        ])

        const ids = request.map((item) => item.id)
        assert.ok(ids.includes("compress-step"))
        assert.ok(!ids.includes("squash-trigger"))
    })
})
