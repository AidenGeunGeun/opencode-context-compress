import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { ModelMessage } from "../lib/messages/v2-transform.ts"
import {
    type CommandFake,
    type ContextMessage,
    fakeSession,
    hostContext,
    type ModelHookInput,
    type SyntheticInput,
    sessionInfo,
} from "./helpers.ts"

describe("built OpenCode 2.3.2 Promise plugin", () => {
    it("loads and executes the command and context paths", async () => {
        const root = await mkdtemp(join(tmpdir(), "context-compress-2013-"))
        const previousConfig = process.env.XDG_CONFIG_HOME
        const previousData = process.env.XDG_DATA_HOME
        process.env.XDG_CONFIG_HOME = join(root, "config")
        process.env.XDG_DATA_HOME = join(root, "data")
        await mkdir(join(root, "config", "opencode"), { recursive: true })
        await writeFile(
            join(root, "config", "opencode", "compress.json"),
            JSON.stringify({ autoCompression: { enabled: false } }),
        )

        try {
            const staged = process.env.OPENCODE_COMPRESS_TEST_BUNDLE
            const bundle = staged ? pathToFileURL(staged).href : "../dist/index.js"
            const { default: plugin }: typeof import("../index.ts") = await import(
                `${bundle}?test=${Date.now()}`
            )

            const commands: CommandFake[] = []
            const hooks = new Map<string, (input: ModelHookInput) => Promise<void> | void>()
            const synthetic: SyntheticInput[] = []
            const registration = { dispose: async () => undefined }
            const sessionID = "session-2013-smoke"
            const projected: ContextMessage[] = [
                { id: "question", type: "user", text: "Continue working", time: { created: 1 } },
                {
                    id: "feedback",
                    type: "synthetic",
                    text: "Status only",
                    description: "Status only",
                    metadata: { "opencode.context-compress.ignored": true },
                    time: { created: 2 },
                },
            ]
            const events = { async *[Symbol.asyncIterator]() {} }
            const cleanup = await plugin.setup(
                hostContext({
                    location: { directory: root },
                    command: {
                        transform: async (callback) => {
                            callback({ add: (command) => commands.push(command) })
                            return registration
                        },
                    },
                    tool: { transform: async () => registration },
                    session: {
                        ...fakeSession({
                            context: async () => projected,
                            synthetic: (input) => synthetic.push(input),
                        }),
                        get: async () => sessionInfo({ location: { directory: root } }),
                        hook: async (name, callback) => {
                            hooks.set(name, callback)
                            return registration
                        },
                    },
                    model: {
                        list: async () => ({
                            data: [
                                {
                                    id: "gpt-test",
                                    providerID: "openai",
                                    limit: { context: 1000 },
                                    cost: [{ input: 2, cache: { read: 0.1 } }],
                                },
                            ],
                        }),
                    },
                    event: { subscribe: () => events },
                }),
            )

            const command = commands.find((item) => item.name === "compress")
            assert.ok(command)
            await command.execute({
                sessionID,
                prompt: { text: "help" },
                delivery: "steer",
            })
            assert.match(synthetic[0].text, /Compress commands/)
            assert.equal(synthetic[0].resume, false)

            const modelMessages: ModelMessage[] = [
                {
                    id: "question",
                    role: "user",
                    content: [{ type: "text", text: "Continue working" }],
                },
                { id: "feedback", role: "user", content: [{ type: "text", text: "Status only" }] },
            ]
            await hooks.get("context")?.({
                sessionID,
                agent: "build",
                model: { providerID: "openai", id: "gpt-test" },
                system: [],
                messages: modelMessages,
                tools: {},
                options: {},
            })
            assert.deepEqual(modelMessages, [
                {
                    id: "question",
                    role: "user",
                    content: [{ type: "text", text: "Continue working" }],
                },
            ])
            await cleanup?.()
        } finally {
            if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME
            else process.env.XDG_CONFIG_HOME = previousConfig
            if (previousData === undefined) delete process.env.XDG_DATA_HOME
            else process.env.XDG_DATA_HOME = previousData
            await rm(root, { recursive: true, force: true })
        }
    })
})
