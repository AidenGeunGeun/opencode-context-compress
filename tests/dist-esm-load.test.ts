import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

describe("built OpenCode 2.0.13 Promise plugin", () => {
    it("loads and executes command, context, generate, and tool paths", async () => {
        const root = await mkdtemp(join(tmpdir(), "context-compress-2013-"))
        const previousConfig = process.env.XDG_CONFIG_HOME
        const previousData = process.env.XDG_DATA_HOME
        process.env.XDG_CONFIG_HOME = join(root, "config")
        process.env.XDG_DATA_HOME = join(root, "data")
        await mkdir(join(root, "config", "opencode"), { recursive: true })
        await writeFile(join(root, "config", "opencode", "compress.json"), JSON.stringify({
            protectedTurns: 0,
            notification: "off",
            autoCompression: { enabled: false },
        }))

        try {
            const staged = process.env.OPENCODE_COMPRESS_TEST_BUNDLE
            const bundle = staged ? pathToFileURL(staged).href : "../dist/index.js"
            const { default: plugin } = await import(`${bundle}?test=${Date.now()}`)
            assert.equal(plugin.id, "opencode-context-compress")
            assert.equal(typeof plugin.setup, "function")
            assert.equal("server" in plugin, false)

            const commands: any[] = []
            const tools: any[] = []
            const hooks = new Map<string, (input: any) => Promise<void>>()
            const synthetic: any[] = []
            const registration = { dispose: async () => undefined }
            const sessionID = "session-2013-smoke"
            const projected = [
                { id: "old-user", type: "user", text: "older", time: { created: 1 } },
                {
                    id: "old-assistant",
                    type: "assistant",
                    agent: "build",
                    model: { providerID: "openai", id: "gpt-test" },
                    content: [{ type: "text", text: "done" }],
                    finish: "stop",
                    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: 2, completed: 3 },
                },
                { id: "owner", type: "user", text: "compress now", time: { created: 4 } },
                {
                    id: "tool-message",
                    type: "assistant",
                    agent: "build",
                    model: { providerID: "openai", id: "gpt-test" },
                    content: [{
                        type: "tool",
                        id: "call-compress",
                        name: "compress",
                        state: { status: "running", input: { summary: "Earlier", topic: "Earlier" } },
                        time: { created: 5 },
                    }],
                    tokens: { input: 12, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: 5 },
                },
            ]
            const events = { async *[Symbol.asyncIterator]() {} }
            const cleanup = await plugin.setup({
                location: { directory: root },
                command: {
                    transform: async (callback: any) => {
                        callback({ add: (command: any) => commands.push(command) })
                        return registration
                    },
                },
                tool: {
                    transform: async (callback: any) => {
                        callback({ add: (tool: any) => tools.push(tool) })
                        return registration
                    },
                },
                session: {
                    context: async () => projected,
                    wait: async () => undefined,
                    synthetic: async (input: any) => void synthetic.push(input),
                    prompt: async () => undefined,
                    get: async () => ({ location: { directory: root } }),
                    hook: async (name: string, callback: any) => {
                        hooks.set(name, callback)
                        return registration
                    },
                },
                model: {
                    list: async () => ({ data: [{
                        id: "gpt-test",
                        providerID: "openai",
                        limit: { context: 1000 },
                    }] }),
                },
                event: { subscribe: () => events },
            } as any)

            assert.deepEqual(commands.map((command) => command.name), ["compress"])
            assert.deepEqual(tools.map((tool) => tool.name), ["compress", "squash"])
            assert.deepEqual([...hooks.keys()], ["context", "generate"])

            await commands[0].execute({
                sessionID,
                prompt: { text: "help" },
                delivery: "steer",
            })
            assert.match(synthetic[0].text, /Compress commands/)
            assert.equal(synthetic[0].resume, false)

            const modelMessages = [
                { id: "old-user", role: "user", content: [{ type: "text", text: "older" }] },
                { id: "old-assistant", role: "assistant", content: [{ type: "text", text: "done" }] },
                { id: "owner", role: "user", content: [{ type: "text", text: "compress now" }] },
                { id: "tool-message", role: "assistant", content: [{ type: "tool-call", id: "call-compress", name: "compress", input: {} }] },
            ]
            await hooks.get("context")?.({
                sessionID,
                agent: "build",
                model: { providerID: "openai", id: "gpt-test" },
                system: [],
                messages: modelMessages,
                tools: {},
                generation: {},
                providerOptions: {},
            })
            assert.equal(modelMessages.length, 4)

            const result = await tools[0].execute(
                { summary: "Earlier work completed", topic: "Earlier" },
                { sessionID, agent: "build", messageID: "tool-message", id: "call-compress", progress: async () => undefined },
            )
            assert.match(result.content, /Compression complete/)

            const sideMessages = [
                ...modelMessages.map((message) => structuredClone(message)),
                { role: "user", content: [{ type: "text", text: "What happened earlier?" }] },
            ]
            await hooks.get("generate")?.({
                sessionID,
                agent: "build",
                model: { providerID: "openai", id: "gpt-test" },
                system: [],
                messages: sideMessages,
                tools: {},
                generation: {},
                providerOptions: {},
            })
            assert.equal(sideMessages.some((message) => message.id === "old-user" || message.id === "old-assistant"), false)
            assert.match(JSON.stringify(sideMessages), /Earlier work completed/)
            assert.deepEqual(sideMessages.at(-1), {
                role: "user",
                content: [{ type: "text", text: "What happened earlier?" }],
            })
            assert.equal(projected.length, 4)
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
