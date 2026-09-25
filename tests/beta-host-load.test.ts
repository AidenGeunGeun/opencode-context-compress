import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"

test("OpenCode 2.0.13 activates compression and registers its command", { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "context-compress-host-"))
    const config = join(root, "config", "opencode")
    await mkdir(config, { recursive: true })
    await writeFile(join(config, "opencode.jsonc"), JSON.stringify({
        compaction: { auto: false },
        plugins: [{ package: resolve(process.env.OPENCODE_COMPRESS_DIST_DIR ?? "dist") }],
    }))
    await writeFile(join(config, "compress.jsonc"), JSON.stringify({ autoCompression: { enabled: false } }))
    const server = spawn(resolve("node_modules/.bin/opencode"), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: root,
        env: {
            HOME: root,
            PATH: process.env.PATH,
            OPENCODE_CONFIG_DIR: config,
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_DATA_HOME: join(root, "data"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_CACHE_HOME: join(root, "cache"),
        },
        stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    let errors = ""
    server.stdout.on("data", (chunk) => { output += chunk.toString() })
    server.stderr.on("data", (chunk) => { errors += chunk.toString() })
    const exited = new Promise<void>((resolve, reject) => {
        server.once("exit", () => resolve())
        server.once("error", reject)
    })
    try {
        for (let attempt = 0; attempt < 150 && !output.match(/server password (\S+)/); attempt++) {
            assert.equal(server.exitCode, null, errors)
            await setTimeout(100)
        }
        const url = output.match(/server listening on (\S+)/)?.[1]
        const password = output.match(/server password (\S+)/)?.[1]
        assert.ok(url && password, `Missing startup endpoint: ${output}${errors}`)
        const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
        let inventory: { data: Array<{ id: string; state: { status: string } }> } = { data: [] }
        for (let attempt = 0; attempt < 100; attempt++) {
            const plugins = await fetch(`${url}/api/plugin`, { headers })
            assert.equal(plugins.status, 200)
            inventory = await plugins.json()
            if (inventory.data.some((plugin) =>
                plugin.id === "opencode-context-compress" && plugin.state.status === "active")) break
            await setTimeout(100)
        }
        assert.ok(inventory.data.some((plugin) =>
            plugin.id === "opencode-context-compress" && plugin.state.status === "active"), JSON.stringify(inventory))
        const commands = await fetch(`${url}/api/command`, { headers })
        assert.equal(commands.status, 200)
        const registered = await commands.json()
        assert.ok(registered.data.some((command: { name: string }) => command.name === "compress"), JSON.stringify(registered))
    } finally {
        server.kill()
        await exited
        await rm(root, { recursive: true, force: true })
    }
})
