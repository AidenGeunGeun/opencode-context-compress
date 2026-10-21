import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { isolateHostDirs } from "./helpers.ts"

const root = await isolateHostDirs()
const { DEFAULT_AUTO_COMPRESSION, getConfig, getInvalidConfigKeys, resolveProtectedTurnsSetting } =
    await import("../lib/config.ts")
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
    it("rejects keys outside the documented surface", () => {
        assert.deepEqual(
            getInvalidConfigKeys({
                autoCompression: { tokenThreshold: 200_000 },
                periodicNudge: { enabled: true },
            }),
            ["periodicNudge", "periodicNudge.enabled"],
        )
    })
})

describe("protectedTurns configuration", () => {
    it("defaults to three", () => {
        assert.equal(resolveProtectedTurnsSetting({}), 3)
    })

    it("accepts the legacy nested key as a fallback", () => {
        assert.equal(resolveProtectedTurnsSetting({ autoCompression: { protectedTurns: 7 } }), 7)
    })

    it("prefers the new top-level key when both are present", () => {
        assert.equal(
            resolveProtectedTurnsSetting({
                protectedTurns: 2,
                autoCompression: { protectedTurns: 7 },
            }),
            2,
        )
    })

    it("does not let a lower-priority legacy alias replace an explicit top-level value", () => {
        assert.equal(
            resolveProtectedTurnsSetting({ autoCompression: { protectedTurns: 9 } }, 2, true),
            2,
        )
    })
})

describe("getConfig layering", () => {
    it("lets the config dir override global and the project override both", async () => {
        const config = await loadLayers({
            global: {
                notification: "off",
                protectedTurns: 1,
                autoCompression: { tokenThreshold: 100 },
            },
            configDir: { notification: "minimal", autoCompression: { tokenThreshold: 200 } },
            project: { autoCompression: { tokenThreshold: 300 } },
        })
        assert.equal(config.notification, "minimal")
        assert.equal(config.protectedTurns, 1)
        assert.deepEqual(config.autoCompression, {
            ...DEFAULT_AUTO_COMPRESSION,
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
        assert.deepEqual(config.autoCompression, DEFAULT_AUTO_COMPRESSION)
        const message = warn.mock.calls[0]?.arguments[0]
        assert.match(message, /autoCompression: expected object, got null/)
        assert.match(message, /commands: expected \{ enabled: boolean \}, got null/)
    })

    it("falls back to the lower layer for mistyped and out-of-range values", async (t) => {
        const warn = t.mock.method(console, "warn", () => undefined)
        const config = await loadLayers({
            global: {
                protectedTurns: 2,
                autoCompression: { contextWindowRatio: 0.5, tokenThreshold: 1000 },
            },
            project: {
                debug: "yes",
                protectedTurns: -1,
                autoCompression: { enabled: "no", contextWindowRatio: 1.5, tokenThreshold: 0 },
            },
        })
        assert.equal(config.debug, false)
        assert.equal(config.protectedTurns, 2)
        assert.deepEqual(config.autoCompression, {
            enabled: true,
            contextWindowRatio: 0.5,
            tokenThreshold: 1000,
        })
        assert.equal(warn.mock.callCount(), 1)
    })
})
