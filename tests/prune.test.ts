import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"

import type { WithParts } from "../lib/state/types.ts"
import {
    fakeSession,
    hostContext,
    isolateHostDirs,
    type ModelHookInput,
    type ModelRequestHookInput,
    modelRequest,
    sessionInfo,
} from "./helpers.ts"

const root = await isolateHostDirs()
const { PROTECTED_TOOLS, pruneStaleToolOutputs } = await import("../lib/messages/prune.ts")
const { setup } = await import("../lib/plugin.ts")
const { transformV2Messages } = await import("../lib/messages/v2-transform.ts")
const { Logger } = await import("../lib/logger.ts")
const { SessionStateManager } = await import("../lib/state/state.ts")
const { loadSessionState } = await import("../lib/state/persistence.ts")
after(() => rm(root, { recursive: true, force: true }))

const logger = new Logger({ daily: false, context: false })
const NOW = Date.now()
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
    it("prunes every aged output in one batch and keeps recent and protected calls", async () => {
        const outputs: Array<[string, string]> = [
            ["read", "r".repeat(20_000)],
            ["edit", "Edit applied"],
            ["subagent", "Subagent report"],
            ["shell", "s".repeat(20_000)],
            ...Array.from({ length: 12 }, (): [string, string] => ["shell", "ok"]),
        ]
        const messages = transcript(outputs, 10)
        messages.splice(2, 0, step("failed", "shell", "", NOW - 30 * MINUTE, "error"))
        const state = freshState()

        await pruneStaleToolOutputs(messages, state, logger, false)

        assert.deepEqual([...state.compressed.toolIds].sort(), [
            "call-a0",
            "call-a3",
            "call-a4",
            "call-a5",
            "call-failed",
        ])
    })

    it("waits while the reads paid so far are small next to the cache rewrite", async () => {
        const outputs: Array<[string, string]> = [
            ["read", "r".repeat(1_000)],
            ...Array.from({ length: 12 }, (): [string, string] => ["shell", "s".repeat(10_000)]),
        ]
        const state = freshState()

        await pruneStaleToolOutputs(transcript(outputs, 0), state, logger, false)

        assert.equal(state.compressed.toolIds.size, 0)
    })

    it("prunes regardless of rent once the cache has expired", async () => {
        const outputs: Array<[string, string]> = [
            ["read", "r".repeat(1_000)],
            ...Array.from({ length: 12 }, (): [string, string] => ["shell", "s".repeat(10_000)]),
        ]
        const prune = async (idleMinutes: number) => {
            const state = freshState()
            await pruneStaleToolOutputs(transcript(outputs, idleMinutes), state, logger, false)
            return state.compressed.toolIds.size
        }

        assert.equal(await prune(59), 0)
        assert.equal(await prune(61), 3)
    })

    it("prices stale reads at the model's listed cache read ratio", async () => {
        const outputs: Array<[string, string]> = [
            ["read", "r".repeat(20_000)],
            ...Array.from({ length: 20 }, (): [string, string] => ["shell", "s".repeat(3_000)]),
        ]
        const prune = async (cacheReadRatio?: number) => {
            const state = freshState()
            state.modelContext = {
                providerId: "anthropic",
                modelId: "m",
                contextLimit: 1_000_000,
                cacheReadRatio,
            }
            await pruneStaleToolOutputs(transcript(outputs, 0), state, logger, false)
            return state.compressed.toolIds.size
        }

        assert.ok((await prune()) > 0)
        assert.equal(await prune(0.05), 0)
    })

    it("only grows pruning marks across two pruning events and a reload", async () => {
        const outputs: Array<[string, string]> = [
            ...Array.from({ length: 40 }, (): [string, string] => ["read", "r".repeat(20_000)]),
            ...Array.from({ length: 10 }, (): [string, string] => ["shell", "s".repeat(3_000)]),
        ]
        const messages = transcript(outputs, 0)
        const state = freshState()
        await pruneStaleToolOutputs(messages, state, logger, false)
        const firstMarks = Array.from({ length: 40 }, (_, index) => `call-a${index}`)
        assert.deepEqual(state.compressed.toolIds, new Set(firstMarks))

        messages.push(step("next", "shell", "s".repeat(3_000), NOW + MINUTE))
        await pruneStaleToolOutputs(messages, state, logger, false)
        assert.deepEqual(state.compressed.toolIds, new Set(firstMarks))

        messages.push(
            ...Array.from({ length: 30 }, (_, index) =>
                step(`later-${index}`, "read", "r".repeat(20_000), NOW + (index + 2) * MINUTE),
            ),
        )
        await pruneStaleToolOutputs(messages, state, logger, false)
        const allMarks = [
            ...Array.from({ length: 50 }, (_, index) => `call-a${index}`),
            "call-next",
            ...Array.from({ length: 20 }, (_, index) => `call-later-${index}`),
        ]
        assert.deepEqual(state.compressed.toolIds, new Set(allMarks))
        assert.ok(state.sessionId)
        const reloaded = await loadSessionState(state.sessionId, logger)
        assert.equal(reloaded.status, "loaded")
        assert.deepEqual(new Set(reloaded.state.compressed.toolIds), new Set(allMarks))
    })

    it("keeps request bytes stable and shows the stub in place of pruned output", async () => {
        const outputs: Array<[string, string]> = Array.from(
            { length: 14 },
            (_, index): [string, string] => ["shell", index < 2 ? "x".repeat(20_000) : "ok"],
        )
        const messages = transcript(outputs, 10)
        const state = freshState()
        await pruneStaleToolOutputs(messages, state, logger, false)
        const marked = [...state.compressed.toolIds]
        assert.deepEqual(marked, ["call-a0", "call-a1", "call-a2", "call-a3"])

        // Nothing new has aged past the protected steps, so a later request changes no marks.
        await pruneStaleToolOutputs(messages, state, logger, false)
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
        const first = transformV2Messages(messages, state, model)
        const second = transformV2Messages(messages, state, model)
        assert.equal(JSON.stringify(first), JSON.stringify(second))
        assert.match(JSON.stringify(first), /Output pruned to save context/)
        assert.doesNotMatch(JSON.stringify(first), /"value":"original"/)
    })

    it("prices the rewrite from the system prompt unless the request anchors the cache", async () => {
        // A large protected output sits before the stale ones: rewriting it costs far more than
        // the stale reads so far, unless a cache anchor before the stale outputs keeps it cached.
        const outputs: Array<[string, string]> = [
            ["subagent", "s".repeat(300_000)],
            ...Array.from({ length: 3 }, (): [string, string] => ["shell", "x".repeat(3_000)]),
            ...Array.from({ length: 10 }, (): [string, string] => ["shell", "ok"]),
        ]
        const unanchored = freshState()
        await pruneStaleToolOutputs(transcript(outputs, 0), unanchored, logger, false)
        assert.equal(unanchored.compressed.toolIds.size, 0)

        const anchored = freshState()
        await pruneStaleToolOutputs(transcript(outputs, 0), anchored, logger, true)
        assert.deepEqual([...anchored.compressed.toolIds], ["call-a1", "call-a2", "call-a3"])
    })

    it("prunes Anthropic requests server-side, with both frontiers anchored for the next primary request", async () => {
        const messages = transcript(
            [
                ["subagent", "s".repeat(300_000)],
                ...Array.from({ length: 3 }, (): [string, string] => ["shell", "x".repeat(3_000)]),
                ...Array.from({ length: 10 }, (): [string, string] => ["shell", "ok"]),
            ],
            0,
        )
        const hooks = new Map<
            string,
            (input: ModelHookInput | ModelRequestHookInput) => Promise<void> | void
        >()
        const registration = { dispose: async () => undefined }
        await setup(
            hostContext({
                location: { directory: root },
                command: { transform: async () => registration },
                tool: { transform: async () => registration },
                session: {
                    ...fakeSession({ context: async () => messages }),
                    get: async () => sessionInfo({ location: { directory: root } }),
                    hook: async (name, callback) => {
                        hooks.set(name, callback)
                        return registration
                    },
                },
                model: { list: async () => ({ data: [] }) },
                event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
            }),
        )
        const context = async (providerID: string) => {
            const event = {
                sessionID: "s",
                agent: "build",
                model: { providerID, id: "model" },
                system: [],
                // Each call gets its result, so a stub would show in the request.
                messages: modelRequest(messages).flatMap((message) => [
                    message,
                    ...message.content.flatMap((part) =>
                        part.type === "tool-call"
                            ? [
                                  {
                                      role: "tool" as const,
                                      content: [
                                          {
                                              type: "tool-result",
                                              id: part.id,
                                              result: { type: "text", value: "original" },
                                          },
                                      ],
                                  },
                              ]
                            : [],
                    ),
                ]),
                tools: {},
                options: {},
            }
            await hooks.get("context")?.(event)
            return JSON.stringify(event.messages).includes("[Output pruned to save context.]")
        }
        const request = async (kind: ModelRequestHookInput["kind"]) => {
            const headers: Record<string, string> = {}
            await hooks.get("model.request")?.({
                sessionID: "s",
                agent: "build",
                model: { providerID: "anthropic", id: "model" },
                kind,
                headers,
            })
            return [headers["x-opencode-cache-anchors"], headers["x-opencode-tool-clearing"]]
        }
        const clearing = JSON.stringify({ from: "call-a4", exclude: [...PROTECTED_TOOLS] })

        // The prune reaches Anthropic only as server-side clearing of the calls before call-a4.
        assert.equal(await context("anthropic"), false)
        assert.deepEqual(await request("title"), [undefined, undefined])
        assert.deepEqual(await request("primary"), ["call-a1,call-a4", clearing])
        assert.deepEqual(await request("primary"), [undefined, clearing])

        // A retry finds the prune already saved; the old frontier stays anchored until the next prune.
        assert.equal(await context("anthropic"), false)
        assert.deepEqual(await request("primary"), ["call-a1,call-a4", clearing])

        // Other providers see the stubs and send neither header.
        assert.equal(await context("openai"), true)
    })

    it("does not prune while a management turn is open", async () => {
        const outputs: Array<[string, string]> = Array.from(
            { length: 12 },
            (): [string, string] => ["shell", "s".repeat(1_000)],
        )
        const messages = transcript(outputs, 61)
        const control = freshState()
        await pruneStaleToolOutputs(messages, control, logger, false)
        assert.deepEqual([...control.compressed.toolIds], ["call-a0", "call-a1"])
        const state = freshState()
        state.managementTurns = [{ triggerMessageId: "user", cleanupVersion: 2 }]

        await pruneStaleToolOutputs(messages, state, logger, false)

        assert.equal(state.compressed.toolIds.size, 0)
    })
})
