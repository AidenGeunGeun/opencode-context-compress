import { execFile } from "node:child_process"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const envKeys = [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_SERVER_PASSWORD",
] as const

async function createSandbox() {
    const sandbox = await mkdtemp(join(tmpdir(), "compress-plugin-esm-"))
    return {
        root: sandbox,
        configHome: join(sandbox, "config"),
        dataHome: join(sandbox, "data"),
        opencodeConfigDir: join(sandbox, "opencode-config"),
    }
}

async function withIsolatedProcessEnv<T>(fn: (sandbox: Awaited<ReturnType<typeof createSandbox>>) => Promise<T>) {
    const sandbox = await createSandbox()
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
        (typeof envKeys)[number],
        string | undefined
    >

    process.env.XDG_CONFIG_HOME = sandbox.configHome
    process.env.XDG_DATA_HOME = sandbox.dataHome
    process.env.OPENCODE_CONFIG_DIR = sandbox.opencodeConfigDir
    process.env.OPENCODE_SERVER_PASSWORD = ""

    try {
        return await fn(sandbox)
    } finally {
        for (const key of envKeys) {
            if (previous[key] === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = previous[key]
            }
        }
        await rm(sandbox.root, { recursive: true, force: true })
    }
}

function sandboxEnv(sandbox: Awaited<ReturnType<typeof createSandbox>>): NodeJS.ProcessEnv {
    return {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        XDG_CONFIG_HOME: sandbox.configHome,
        XDG_DATA_HOME: sandbox.dataHome,
        OPENCODE_CONFIG_DIR: sandbox.opencodeConfigDir,
        OPENCODE_SERVER_PASSWORD: "",
    }
}

function assertHookContract(hooks: Hooks) {
    assert.equal(typeof hooks, "object")
    assert.equal(typeof hooks.event, "function")
    assert.equal(typeof hooks["experimental.chat.messages.transform"], "function")
    assert.equal(typeof hooks["chat.params"], "function")
    assert.equal(typeof hooks["chat.message"], "function")
    assert.equal(typeof hooks["command.execute.before"], "function")
    assert.equal(typeof hooks.config, "function")

    assert.equal(typeof hooks.tool, "object")
    assert.deepEqual(Object.keys(hooks.tool ?? {}), ["compress"])

    for (const toolName of ["compress"] as const) {
        const definition = hooks.tool?.[toolName]
        assert.equal(typeof definition?.description, "string")
        assert.equal(typeof definition?.args, "object")
        assert.equal(typeof definition?.execute, "function")
    }
}

describe("built Node ESM package", () => {
    it("loads dist/index.js in a fresh Node ESM process", async () => {
        const sandbox = await createSandbox()
        try {
            const script = `
                import('./dist/index.js')
                    .then((module) => {
                        if (typeof module.default !== 'function') {
                            throw new Error('default export is not a function')
                        }
                        console.log(typeof module.default)
                    })
                    .catch((error) => {
                        console.error(error?.stack || error?.message || error)
                        process.exit(1)
                    })
            `

            const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
                cwd: projectRoot,
                env: sandboxEnv(sandbox),
            })

            assert.equal(stdout.trim(), "function")
        } finally {
            await rm(sandbox.root, { recursive: true, force: true })
        }
    })

    it("returns the expected plugin hooks from the built default export", async () => {
        await withIsolatedProcessEnv(async (sandbox) => {
            const moduleUrl = pathToFileURL(join(projectRoot, "dist", "index.js")).href
            const { default: plugin } = (await import(moduleUrl)) as {
                default: (input: PluginInput) => Promise<Hooks>
            }

            assert.equal(typeof plugin, "function")

            const client = {
                session: {
                    get: async () => ({ data: {} }),
                    messages: async () => ({ data: [] }),
                },
                tui: {
                    showToast: async () => undefined,
                    appendPrompt: async () => undefined,
                },
            } as unknown as PluginInput["client"]

            const ctx: PluginInput = {
                client,
                directory: sandbox.root,
                worktree: sandbox.root,
                project: {} as PluginInput["project"],
                serverUrl: new URL("http://127.0.0.1"),
                $: undefined as unknown as PluginInput["$"],
            }

            const hooks = await plugin(ctx)
            assertHookContract(hooks)

            const opencodeConfig: Record<string, any> = {}
            await hooks.config?.(opencodeConfig as any)
            assert.equal(opencodeConfig.compaction.auto, false)
            assert.equal(opencodeConfig.command.compress.description, "Show available context compression commands")
            assert.deepEqual(opencodeConfig.experimental.primary_tools, ["compress"])
            assert.equal("compress_map" in opencodeConfig.permission, false)
            assert.equal(opencodeConfig.permission.compress, "allow")

            await hooks["chat.message"]?.(
                { sessionID: "contract-session", variant: "contract" },
                { message: {} as any, parts: [] },
            )
            await hooks["experimental.chat.messages.transform"]?.({}, { messages: [] })
            await hooks["command.execute.before"]?.(
                { command: "unrelated", sessionID: "contract-session", arguments: "" },
                { parts: [] },
            )
        })
    })

    it("ships the deterministic selector's fail-closed reconciliation guard", async () => {
        const moduleUrl = pathToFileURL(
            join(projectRoot, "dist", "lib", "messages", "context-map.js"),
        ).href
        const { selectDeterministicCompressionSpan } = (await import(moduleUrl)) as {
            selectDeterministicCompressionSpan: (...args: any[]) => unknown
        }
        const state = {
            compressed: { toolIds: new Set(), messageIds: new Set(["missing-anchor"]) },
            compressSummaries: [
                {
                    anchorMessageId: "missing-anchor",
                    messageIds: ["missing-anchor"],
                    summary: "durable block",
                },
            ],
            managementTurns: [],
        }
        const messages = [
            {
                info: {
                    id: "visible",
                    role: "user",
                    sessionID: "dist-selection",
                    time: { created: Date.now() },
                },
                parts: [{ type: "text", text: "visible" }],
            },
        ]

        assert.throws(
            () =>
                selectDeterministicCompressionSpan(
                    messages,
                    state,
                    { info: () => {}, warn: () => {} },
                    0,
                ),
            /could not reconcile an existing compressed block/,
        )
    })
})
