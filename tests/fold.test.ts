import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
    type CommandFake,
    type CompactInput,
    type CompactionHookInput,
    type ContextMessage,
    fakeSession,
    hostContext,
    isolateHostDirs,
    type HostFake,
    type ModelHookInput,
    modelText,
    type PromptInput,
    sessionInfo,
    type ToolFake,
} from "./helpers.ts"

const root = await isolateHostDirs()
await mkdir(join(root, "config", "opencode"), { recursive: true })
await writeFile(
    join(root, "config", "opencode", "compress.jsonc"),
    JSON.stringify({ autoCompression: { tokenThreshold: 1_000, contextWindowRatio: 0.5 } }),
)
const { setup } = await import("../lib/plugin.ts")
const { createSessionState } = await import("../lib/state/state.ts")
const { saveSessionState, loadSessionState } = await import("../lib/state/persistence.ts")
const { Logger } = await import("../lib/logger.ts")
after(() => rm(root, { recursive: true, force: true }))

/** Starts the plugin and returns its compress tool, compaction hook, and a way to deliver events. */
async function start(
    session: Partial<HostFake["session"]> = {},
    model: HostFake["model"] = { list: async () => ({ data: [] }) },
) {
    const registration = { dispose: async () => undefined }
    const tools: ToolFake[] = []
    const commands: CommandFake[] = []
    const prompts: PromptInput[] = []
    const compactions: CompactInput[] = []
    let compactionHook: ((input: CompactionHookInput) => Promise<void> | void) | undefined
    let contextHook: ((input: ModelHookInput) => Promise<void> | void) | undefined
    // `send` resolves once the plugin asks for the next event, so the previous one is fully handled.
    let deliver: ((event: unknown) => void) | undefined
    let handled: (() => void) | undefined
    const events = {
        [Symbol.asyncIterator]: () => ({
            next: () => {
                handled?.()
                return new Promise<IteratorResult<unknown>>((resolve) => {
                    deliver = (value) => resolve({ value, done: false })
                })
            },
        }),
    }
    await setup(
        hostContext({
            location: { directory: root },
            command: {
                transform: async (callback) => {
                    callback({ add: (command) => commands.push(command) })
                    return registration
                },
            },
            tool: {
                transform: async (callback) => {
                    callback({ add: (tool) => tools.push(tool) })
                    return registration
                },
            },
            session: {
                ...fakeSession({
                    prompt: (input) => prompts.push(input),
                    compact: (input) => compactions.push(input),
                }),
                get: async (input) =>
                    sessionInfo({
                        location: { directory: root },
                        ...(input.sessionID.startsWith("child") ? { parentID: "parent" } : {}),
                    }),
                ...session,
                hook: async (name, callback) => {
                    if (name === "compaction") compactionHook = callback
                    if (name === "context") contextHook = callback
                    return registration
                },
            },
            model,
            event: { subscribe: () => events },
        }),
    )
    const tool = tools.find((item) => item.name === "compress")
    const hook = compactionHook
    const context = contextHook
    if (!tool || !hook || !context)
        throw new Error("The plugin did not register compress and its compaction hook")
    return {
        prompts,
        compactions,
        context: async (sessionID: string, messages: ModelHookInput["messages"]) => {
            await context({
                sessionID,
                agent: "build",
                model: { providerID: "openai", id: "gpt-test" },
                system: [],
                messages,
                tools: {},
                options: {},
            })
        },
        command: (sessionID: string, text: string) =>
            commands
                .find((item) => item.name === "compress")
                ?.execute({ sessionID, prompt: { text }, delivery: "queue" }),
        compress: (sessionID: string, summary: string) =>
            tool.execute(
                { summary },
                { sessionID, agent: "build", messageID: "m", id: "c", progress: async () => {} },
            ),
        compaction: async (sessionID: string) => {
            const event: CompactionHookInput = {
                sessionID,
                agent: "compaction",
                model: { providerID: "openai", id: "gpt-test" },
                system: [],
                messages: [],
                tools: {},
                options: {},
            }
            await hook(event)
            return event.result
        },
        send: (event: Record<string, unknown>) =>
            new Promise<void>((resolve) => {
                handled = resolve
                deliver?.({ created: Date.now(), location: { directory: root }, ...event })
            }),
    }
}

describe("compress", () => {
    it("hands its summary to the next compaction only, without the kept recent messages", async () => {
        const plugin = await start()

        await plugin.compress("s1", "  The summary.  ")
        const result = await plugin.compaction("s1")

        assert.deepEqual(plugin.compactions, [{ sessionID: "s1" }])
        assert.ok(result?.summary.startsWith("The summary.\n\n"))
        assert.ok(result?.metadata && "keepID" in result.metadata)
        assert.equal(result?.metadata?.keepID, undefined)
        await plugin.send({ type: "session.compaction.ended", data: { sessionID: "s1" } })
        assert.equal(await plugin.compaction("s1"), undefined)
    })

    it("drops a summary whose compaction failed", async () => {
        const plugin = await start()

        await plugin.compress("s2", "Stale summary.")
        await plugin.send({ type: "session.compaction.failed", data: { sessionID: "s2" } })

        assert.equal(await plugin.compaction("s2"), undefined)
    })

    it("drops a summary whose compaction was cancelled before it ran", async () => {
        const plugin = await start()
        const cancelled = (inboxID: string) =>
            plugin.send({ type: "session.inbox.cancelled", data: { sessionID: "s5", inboxID } })

        await plugin.compress("s5", "Stale summary.")
        await cancelled("another-item")
        assert.ok(await plugin.compaction("s5"))

        await cancelled("compaction")
        assert.equal(await plugin.compaction("s5"), undefined)
    })
})

describe("fold request", () => {
    it("deduplicates the same trigger across instances but admits a different trigger", async () => {
        const inbox = new Set<string>()
        const session = fakeSession({
            prompt: ({ id }) => {
                assert.ok(id)
                inbox.add(id)
            },
        })
        const first = await start(session)
        const second = await start(session)
        const event = {
            type: "session.step.ended",
            created: 10_000,
            data: {
                sessionID: "dedup",
                assistantMessageID: "first-trigger",
                tokens: { input: 1_000 },
            },
        }
        await first.send(event)
        await second.send(event)
        assert.equal(inbox.size, 1, "two instances must admit only one request for the same step")
        const [inboxID] = inbox
        await second.send({
            type: "session.inbox.delivered",
            data: { sessionID: "dedup", inboxID },
        })
        await second.send({
            ...event,
            data: { ...event.data, assistantMessageID: "next-trigger", tokens: { input: 101_000 } },
        })
        assert.equal(inbox.size, 2, "a different triggering step must get a distinct request")
    })

    it("requests a fold at the smaller context-window share rather than the absolute limit", async () => {
        const plugin = await start(
            {
                context: async () => [
                    {
                        id: "question",
                        type: "user",
                        time: { created: 1 },
                        text: "Continue",
                    },
                ],
            },
            {
                list: async () => ({
                    data: [
                        {
                            id: "gpt-test",
                            providerID: "openai",
                            limit: { context: 1_000 },
                            cost: [],
                        },
                    ],
                }),
            },
        )
        await plugin.context("ratio", [
            { id: "question", role: "user", content: [{ type: "text", text: "Continue" }] },
        ])
        const step = (input: number) =>
            plugin.send({
                type: "session.step.ended",
                data: {
                    sessionID: "ratio",
                    assistantMessageID: `step-${input}`,
                    tokens: { input },
                },
            })
        await step(499)
        assert.equal(plugin.prompts.length, 0)
        await step(500)
        assert.equal(
            plugin.prompts.length,
            1,
            "50% of a 1,000-token window is 500, below the 1,000 absolute limit",
        )
    })

    it("is sent at the threshold and again at each further 100k tokens or after the context shrank", async () => {
        const plugin = await start()
        let step = 0
        const stepEnded = (input: number) =>
            plugin.send({
                type: "session.step.ended",
                data: {
                    sessionID: "s3",
                    assistantMessageID: `step-${++step}`,
                    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
            })
        const sentAfter = async (input: number) => {
            await stepEnded(input)
            const latest = plugin.prompts.at(-1)?.id
            if (latest)
                await plugin.send({
                    type: "session.inbox.delivered",
                    data: { sessionID: "s3", inboxID: latest },
                })
            return plugin.prompts.length
        }

        assert.equal(await sentAfter(999), 0)
        assert.equal(await sentAfter(1_000), 1)
        assert.equal(await sentAfter(100_999), 1)
        assert.equal(await sentAfter(101_000), 2)
        assert.equal(await sentAfter(500), 2)
        assert.equal(await sentAfter(1_000), 3)
    })

    it("is not sent while the session has fold requests turned off", async () => {
        const plugin = await start()
        let step = 0
        const stepEnded = (input: number) =>
            plugin.send({
                type: "session.step.ended",
                data: {
                    sessionID: "s-off",
                    assistantMessageID: `step-${++step}`,
                    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
            })

        await plugin.command("s-off", "off")
        await stepEnded(1_000)
        await stepEnded(101_000)
        assert.equal(plugin.prompts.length, 0)

        await plugin.command("s-off", "on")
        await stepEnded(101_000)
        assert.equal(plugin.prompts.length, 1)
    })

    it("is not queued again while an earlier request is undelivered, which would fold twice", async () => {
        const plugin = await start()
        let step = 0
        const stepEnded = (input: number) =>
            plugin.send({
                type: "session.step.ended",
                data: {
                    sessionID: "s7",
                    assistantMessageID: `step-${++step}`,
                    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
            })

        await stepEnded(1_000)
        await stepEnded(101_000)
        assert.equal(plugin.prompts.length, 1)

        await plugin.send({
            type: "session.inbox.delivered",
            data: { sessionID: "s7", inboxID: plugin.prompts[0]?.id },
        })
        await stepEnded(201_000)
        assert.equal(plugin.prompts.length, 2)
    })

    it("waits when a subagent's step ends its turn, because that last message is its report", async () => {
        const plugin = await start()
        const stepEnded = (finish: string) =>
            plugin.send({
                type: "session.step.ended",
                data: {
                    sessionID: "child-s6",
                    assistantMessageID: `step-${finish}`,
                    finish,
                    tokens: { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
            })

        await stepEnded("stop")
        assert.equal(plugin.prompts.length, 0)
        await stepEnded("tool-calls")
        assert.equal(plugin.prompts.length, 1)
    })

    it("is not sent for the step that called compress, which the fold is about to replace", async () => {
        const plugin = await start()
        const stepEnded = (assistantMessageID: string) =>
            plugin.send({
                type: "session.step.ended",
                data: {
                    sessionID: "s4",
                    assistantMessageID,
                    tokens: { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
            })

        await plugin.compress("s4", "The summary.")
        await stepEnded("compress-step")
        assert.equal(plugin.prompts.length, 0)

        await plugin.send({ type: "session.compaction.ended", data: { sessionID: "s4" } })
        await stepEnded("later-step")
        assert.equal(plugin.prompts.length, 1)
    })

    it("asks a subagent to hand its findings to the parent instead of editing documentation", async () => {
        const plugin = await start()
        const requestFor = async (sessionID: string) => {
            await plugin.send({
                type: "session.step.ended",
                data: {
                    sessionID,
                    assistantMessageID: "step",
                    tokens: { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
            })
            return plugin.prompts.at(-1)?.text ?? ""
        }

        assert.match(await requestFor("s5"), /librarian/)
        const subagent = await requestFor("child-s5")
        assert.doesNotMatch(subagent, /librarian/)
        assert.match(subagent, /For the parent/)
    })
})

describe("fork lifecycle", () => {
    for (const viaEvent of [true, false]) {
        it(`remaps inherited blocks before the first request ${viaEvent ? "through the fork event" : "when the fork event was missed"}`, async () => {
            const childID = viaEvent ? "fork-event" : "fork-recovery"
            const parent: ContextMessage[] = [
                { id: "parent-old", type: "user", time: { created: 1 }, text: "Old raw work" },
                { id: "parent-tail", type: "user", time: { created: 2 }, text: "Continue working" },
            ]
            const child = parent.map((message, index) => ({
                ...message,
                id: `${childID}-${index}`,
            }))
            const logger = new Logger({ daily: false, context: false })
            const saved = createSessionState()
            saved.sessionId = "fork-parent"
            saved.compressed.messageIds.add("parent-old")
            saved.compressSummaries = [
                {
                    anchorMessageId: "parent-old",
                    messageIds: ["parent-old"],
                    summary: "Archived work.",
                },
            ]
            assert.equal(await saveSessionState(saved, logger), true)
            const plugin = await start({
                ...fakeSession({
                    context: async ({ sessionID }) =>
                        sessionID === "fork-parent" ? parent : child,
                }),
                get: async () =>
                    sessionInfo({
                        location: { directory: root },
                        fork: {
                            sessionID: "fork-parent",
                            boundary: { type: "through", messageID: "parent-tail" },
                        },
                    }),
            })
            if (viaEvent) {
                await plugin.send({ type: "session.forked", data: { sessionID: childID } })
                const inherited = await loadSessionState(childID, logger)
                assert.equal(
                    inherited.status,
                    "loaded",
                    "fork event must persist inheritance before any model request",
                )
                assert.deepEqual(inherited.state.compressed.messageIds, [`${childID}-0`])
            }
            const request: ModelHookInput["messages"] = [
                {
                    id: `${childID}-0`,
                    role: "user",
                    content: [{ type: "text", text: "Old raw work" }],
                },
                {
                    id: `${childID}-1`,
                    role: "user",
                    content: [{ type: "text", text: "Continue working" }],
                },
            ]
            await plugin.context(childID, request)
            assert.match(request.map(modelText).join("\n"), /Archived work\./)
            assert.doesNotMatch(request.map(modelText).join("\n"), /Old raw work/)
            assert.equal(modelText(request.at(-1)), "Continue working")
            const inherited = await loadSessionState(childID, logger)
            assert.equal(inherited.status, "loaded")
            assert.deepEqual(inherited.state.compressSummaries, [
                {
                    anchorMessageId: `${childID}-0`,
                    messageIds: [`${childID}-0`],
                    summary: "Archived work.",
                },
            ])
        })
    }
})
