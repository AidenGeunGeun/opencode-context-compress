import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
    type CompactInput,
    type CompactionHookInput,
    fakeSession,
    hostContext,
    isolateHostDirs,
    type PromptInput,
    sessionInfo,
    type ToolFake,
} from "./helpers.ts"

const root = await isolateHostDirs()
await mkdir(join(root, "config", "opencode"), { recursive: true })
await writeFile(
    join(root, "config", "opencode", "compress.jsonc"),
    JSON.stringify({ autoCompression: { tokenThreshold: 1_000 } }),
)
const { setup } = await import("../lib/plugin.ts")
after(() => rm(root, { recursive: true, force: true }))

/** Starts the plugin and returns its compress tool, compaction hook, and a way to deliver events. */
async function start() {
    const registration = { dispose: async () => undefined }
    const tools: ToolFake[] = []
    const prompts: PromptInput[] = []
    const compactions: CompactInput[] = []
    let compactionHook: ((input: CompactionHookInput) => Promise<void> | void) | undefined
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
            command: { transform: async () => registration },
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
                hook: async (name, callback) => {
                    if (name === "compaction") compactionHook = callback
                    return registration
                },
            },
            model: { list: async () => ({ data: [] }) },
            event: { subscribe: () => events },
        }),
    )
    const tool = tools.find((item) => item.name === "compress")
    const hook = compactionHook
    if (!tool || !hook)
        throw new Error("The plugin did not register compress and its compaction hook")
    return {
        prompts,
        compactions,
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
            return plugin.prompts.length
        }

        assert.equal(await sentAfter(999), 0)
        assert.equal(await sentAfter(1_000), 1)
        assert.equal(await sentAfter(100_999), 1)
        assert.equal(await sentAfter(101_000), 2)
        assert.equal(await sentAfter(500), 2)
        assert.equal(await sentAfter(1_000), 3)
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
