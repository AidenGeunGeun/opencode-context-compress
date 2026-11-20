import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { isolateHostDirs } from "./helpers.ts"

const root = await isolateHostDirs()
const { getConfig, refreshConfig } = await import("../lib/config.ts")
after(() => rm(root, { recursive: true, force: true }))

const layerDirs = {
    global: join(root, "config", "opencode"),
    configDir: join(root, "config-dir"),
    project: join(root, "project", ".opencode"),
}
process.env.OPENCODE_CONFIG_DIR = layerDirs.configDir

async function loadLayers(layers: Partial<Record<keyof typeof layerDirs, unknown>>) {
    for (const layer of ["global", "configDir", "project"] as const) {
        const dir = layerDirs[layer]
        await rm(dir, { recursive: true, force: true })
        await mkdir(dir, { recursive: true })
        const data = layers[layer]
        if (data !== undefined) await writeFile(join(dir, "compress.jsonc"), JSON.stringify(data))
    }
    return getConfig({ directory: join(root, "project") })
}

describe("automatic compression defaults", () => {
    it("warns about unknown file keys without discarding supported values", async (t) => {
        const warn = t.mock.method(console, "warn", () => undefined)
        const config = await loadLayers({
            global: {
                autoCompression: { tokenThreshold: 200_000 },
                periodicNudge: { enabled: true },
            },
        })
        assert.equal(config.autoCompression.tokenThreshold, 200_000)
        assert.match(
            warn.mock.calls.map((call) => call.arguments.join(" ")).join("\n"),
            /periodicNudge\.enabled/,
        )
    })
})

describe("refreshConfig", () => {
    it("reloads the same object after a file is edited, added or removed", async () => {
        const config = await loadLayers({ global: { autoCompression: { tokenThreshold: 100 } } })
        const ctx = { directory: join(root, "project") }
        refreshConfig(config, ctx)
        assert.equal(config.autoCompression.tokenThreshold, 100)

        await writeFile(
            join(layerDirs.global, "compress.jsonc"),
            JSON.stringify({ autoCompression: { tokenThreshold: 500 } }),
        )
        refreshConfig(config, ctx)
        assert.equal(config.autoCompression.tokenThreshold, 500)

        await writeFile(
            join(layerDirs.project, "compress.jsonc"),
            JSON.stringify({ autoCompression: { tokenThreshold: 300 } }),
        )
        refreshConfig(config, ctx)
        assert.equal(config.autoCompression.tokenThreshold, 300)

        await rm(join(layerDirs.project, "compress.jsonc"))
        refreshConfig(config, ctx)
        assert.equal(config.autoCompression.tokenThreshold, 500)
    })
})

describe("getConfig layering", () => {
    it("lets the config dir override global and the project override both", async () => {
        const config = await loadLayers({
            global: {
                debug: true,
                tools: { compress: { permission: "deny" } },
                autoCompression: { tokenThreshold: 100 },
            },
            configDir: {
                tools: { compress: { permission: "ask" } },
                autoCompression: { tokenThreshold: 200 },
            },
            project: { autoCompression: { tokenThreshold: 300 } },
        })
        assert.equal(config.debug, true)
        assert.equal(config.tools.compress.permission, "ask")
        assert.deepEqual(config.autoCompression, {
            enabled: true,
            contextWindowRatio: 0.9,
            tokenThreshold: 300,
        })
    })

    it("treats null sections as absent", async (t) => {
        const warn = t.mock.method(console, "warn", () => undefined)
        const config = await loadLayers({
            global: { commands: { enabled: false }, tools: { compress: { permission: "ask" } } },
            project: { commands: null, autoCompression: null, tools: null },
        })
        assert.equal(config.commands.enabled, false)
        assert.equal(config.tools.compress.permission, "ask")
        assert.deepEqual(config.autoCompression, {
            enabled: true,
            contextWindowRatio: 0.9,
            tokenThreshold: 432_000,
        })
        const message = warn.mock.calls[0]?.arguments[0]
        assert.match(message, /autoCompression: expected object, got null/)
        assert.match(message, /commands: expected \{ enabled: boolean \}, got null/)
    })

    it("falls back to the lower layer for mistyped and out-of-range values", async (t) => {
        const warn = t.mock.method(console, "warn", () => undefined)
        const config = await loadLayers({
            global: {
                autoCompression: { contextWindowRatio: 0.5, tokenThreshold: 1000 },
            },
            project: {
                debug: "yes",
                autoCompression: { enabled: "no", contextWindowRatio: 1.5, tokenThreshold: 0 },
            },
        })
        assert.equal(config.debug, false)
        assert.deepEqual(config.autoCompression, {
            enabled: true,
            contextWindowRatio: 0.5,
            tokenThreshold: 1000,
        })
        assert.equal(warn.mock.callCount(), 1)
    })
})
