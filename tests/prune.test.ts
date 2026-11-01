import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"

import type { WithParts } from "../lib/state/types.ts"
import { isolateHostDirs } from "./helpers.ts"

const root = await isolateHostDirs()
const { pruneStaleToolOutputs } = await import("../lib/messages/prune.ts")
const { transformV2Messages } = await import("../lib/messages/v2-transform.ts")
const { Logger } = await import("../lib/logger.ts")
const { SessionStateManager } = await import("../lib/state/state.ts")
after(() => rm(root, { recursive: true, force: true }))

const logger = new Logger({ daily: false, context: false })
const NOW = 1_800_000_000_000
const MINUTE = 60_000

const step = (
    id: string,
    tool: string,
    output: string,
    completed: number,
    status: "completed" | "error" = "completed",
): WithParts => ({
    info: {
        id,
        sessionID: "s",
        role: "assistant",
        agent: "build",
        providerID: "openai",
        modelID: "gpt-test",
        time: { created: completed - 1_000, completed },
    },
    parts: [
        { type: "step-start" },
        {
            type: "tool",
            callID: `call-${id}`,
            tool,
            state:
                status === "completed"
                    ? { status, input: { command: `run ${id}` }, output }
                    : { status, input: { command: "x".repeat(500) }, error: "failed" },
        },
    ],
})

/** One user message, then one tool step per output; the last step ends `idleMinutes` before NOW. */
const transcript = (outputs: Array<[tool: string, output: string]>, idleMinutes: number) => [
    {
        info: {
            id: "user",
            sessionID: "s",
            role: "user" as const,
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-test" },
            time: { created: NOW - 10 * 60 * MINUTE },
        },
        parts: [{ type: "text" as const, text: "Do the work" }],
    },
    ...outputs.map(([tool, output], index) =>
        step(`a${index}`, tool, output, NOW - (idleMinutes + outputs.length - 1 - index) * MINUTE),
    ),
]

const freshState = () => {
    const state = new SessionStateManager().get(`prune-${Date.now()}-${Math.random()}`)
    state.initialized = true
    state.persistenceSynchronized = true
    return state
}

describe("background pruning", () => {
    it("prunes every aged output at once on a cold cache and keeps recent and protected calls", async () => {
        const outputs: Array<[string, string]> = [
            ["read", "r".repeat(1_000)],
            ["edit", "Edit applied"],
            ["subagent", "Subagent report"],
            ...Array.from({ length: 12 }, (): [string, string] => ["shell", "s".repeat(1_000)]),
        ]
        const messages = transcript(outputs, 10)
        messages.splice(2, 0, step("failed", "shell", "", NOW - 30 * MINUTE, "error"))
        const state = freshState()

        await pruneStaleToolOutputs(messages, state, logger, "openai", NOW)

        assert.deepEqual([...state.compressed.toolIds].sort(), [
            "call-a0",
            "call-a3",
            "call-a4",
            "call-failed",
        ])
    })

    it("waits on a warm cache while rewriting the suffix costs more than the reads it saves", async () => {
        const outputs: Array<[string, string]> = [
            ["read", "r".repeat(100)],
            ...Array.from({ length: 10 }, (): [string, string] => ["shell", "s".repeat(10_000)]),
        ]
        const state = freshState()

        await pruneStaleToolOutputs(transcript(outputs, 0), state, logger, "openai", NOW)

        assert.equal(state.compressed.toolIds.size, 0)
    })

    it("prunes on a warm cache once the saved reads pay for the rewrite", async () => {
        const outputs: Array<[string, string]> = [
            ...Array.from({ length: 40 }, (): [string, string] => ["read", "r".repeat(20_000)]),
            ...Array.from({ length: 10 }, (): [string, string] => ["shell", "ok"]),
        ]
        const state = freshState()

        await pruneStaleToolOutputs(transcript(outputs, 0), state, logger, "anthropic", NOW)

        assert.equal(state.compressed.toolIds.size, 40)
    })

    it("keeps request bytes stable and shows the stub in place of pruned output", async () => {
        const outputs: Array<[string, string]> = Array.from(
            { length: 12 },
            (_, index): [string, string] => ["shell", `output ${index} `.repeat(100)],
        )
        const messages = transcript(outputs, 10)
        const state = freshState()
        await pruneStaleToolOutputs(messages, state, logger, "openai", NOW)
        const marked = [...state.compressed.toolIds]
        assert.deepEqual(marked, ["call-a0", "call-a1"])

        // Nothing new has aged past the protected steps, so a later request changes no marks.
        await pruneStaleToolOutputs(messages, state, logger, "openai", NOW + 20 * MINUTE)
        assert.deepEqual([...state.compressed.toolIds], marked)

        const model = messages.slice(1, 3).flatMap((message) => {
            const part = message.parts[1]
            if (part.type !== "tool") return []
            return [
                {
                    id: message.info.id,
                    role: "assistant",
                    content: [{ type: "tool-call", id: part.callID, name: part.tool, input: {} }],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            id: part.callID,
                            result: { type: "text", value: "original" },
                        },
                    ],
                },
            ]
        })
        const first = transformV2Messages(messages, state, logger, model)
        const second = transformV2Messages(messages, state, logger, model)
        assert.equal(JSON.stringify(first), JSON.stringify(second))
        assert.match(JSON.stringify(first), /Output pruned to save context/)
        assert.doesNotMatch(JSON.stringify(first), /"value":"original"/)
    })

    it("does not prune while a management turn is open", async () => {
        const outputs: Array<[string, string]> = Array.from(
            { length: 12 },
            (): [string, string] => ["shell", "s".repeat(1_000)],
        )
        const messages = transcript(outputs, 10)
        const state = freshState()
        state.managementTurns = [{ triggerMessageId: "user", cleanupVersion: 2 }]

        await pruneStaleToolOutputs(messages, state, logger, "openai", NOW)

        assert.equal(state.compressed.toolIds.size, 0)
    })
})
