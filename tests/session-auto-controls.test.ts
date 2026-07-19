import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { createCommandExecuteHandler } from "../lib/hooks.ts"
import { DEFAULT_AUTO_COMPRESSION, type PluginConfig } from "../lib/config.ts"
import { loadSessionState } from "../lib/state/persistence.ts"
import { SessionStateManager } from "../lib/state/state.ts"

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
} as any

const config: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "off",
    notificationType: "chat",
    commands: { enabled: true, protectedTools: [] },
    autoCompression: { ...DEFAULT_AUTO_COMPRESSION },
    turnProtection: { enabled: false, turns: 0 },
    protectedFilePatterns: [],
    tools: {
        settings: { protectedTools: [] },
        compress: { permission: "allow", showCompression: false },
        compress_map: { permission: "allow" },
    },
}

const getSessionFilePath = (sessionId: string) =>
    join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "compress",
        `${sessionId}.json`,
    )

const cleanupSessionFile = async (sessionId: string) => {
    const path = getSessionFilePath(sessionId)
    if (existsSync(path)) await rm(path)
}

const userMessage = (id: string, sessionID: string) => ({
    info: {
        id,
        sessionID,
        role: "user" as const,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "Continue the task" }],
})

const assistantMessage = (id: string, sessionID: string) => ({
    info: {
        id,
        sessionID,
        role: "assistant" as const,
        agent: "build",
        providerID: "openai",
        modelID: "gpt-test",
        time: { created: Date.now(), completed: Date.now() },
    },
    parts: [{ type: "text", text: "Done" }],
})

function createHarness(sessionId: string, messages: any[], configOverride = config) {
    const ignoredPrompts: any[] = []
    const client = {
        session: {
            get: async () => ({ data: {} }),
            messages: async () => messages,
            prompt: async (input: any) => {
                ignoredPrompts.push(input)
                return { data: { info: { id: `ignored-${ignoredPrompts.length}` } } }
            },
        },
    }
    const stateManager = new SessionStateManager()
    const handler = createCommandExecuteHandler(client, stateManager, logger, configOverride)

    const run = async (arguments_: string) => {
        const output = { parts: [{ type: "text", text: "default" }], cancelled: false }
        await handler({ command: "compress", sessionID: sessionId, arguments: arguments_ }, output)
        assert.equal(output.cancelled, true)
        assert.deepEqual(output.parts, [])
        const call = ignoredPrompts.at(-1)
        const part = call?.body?.parts?.[0] ?? call?.parts?.[0]
        assert.equal(part?.ignored, true)
        return part?.text as string
    }

    return { stateManager, run }
}

describe("session automatic-compression commands", () => {
    it("treats repeated on/off requests as sourced no-ops without redundant persistence", async () => {
        const sessionId = `session-auto-idempotent-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const filePath = getSessionFilePath(sessionId)
        const { run } = createHarness(sessionId, [userMessage("u1", sessionId)])

        try {
            const alreadyOn = await run("auto on")
            assert.match(alreadyOn, /already on \(config\)/)
            assert.equal(existsSync(filePath), false)

            assert.match(await run("auto off"), /off for this session/)
            const afterOff = await readFile(filePath, "utf8")
            const afterOffInode = (await stat(filePath)).ino
            const alreadyOff = await run("auto off")
            assert.match(alreadyOff, /already off \(session override\)/)
            assert.equal(await readFile(filePath, "utf8"), afterOff)
            assert.equal((await stat(filePath)).ino, afterOffInode)

            assert.match(await run("auto on"), /on for this session/)
            const afterOn = await readFile(filePath, "utf8")
            const afterOnInode = (await stat(filePath)).ino
            const secondOn = await run("auto on")
            assert.match(secondOn, /already on \(session override\)/)
            assert.equal(await readFile(filePath, "utf8"), afterOn)
            assert.equal((await stat(filePath)).ino, afterOnInode)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("persists independent on/off, threshold, and ratio settings and reports provenance", async () => {
        const sessionId = `session-auto-controls-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const messages = [
            userMessage("u1", sessionId),
            assistantMessage("compress-anchor", sessionId),
            userMessage("u2", sessionId),
            assistantMessage("a1", sessionId),
        ]
        const { stateManager, run } = createHarness(sessionId, messages)
        const state = stateManager.get(sessionId)
        state.compressionCooldownAfterMessageId = "compress-anchor"

        try {
            await run("auto threshold 250000")
            await run("auto ratio 75")
            const offMessage = await run("auto off")
            assert.match(offMessage, /Both absolute and ratio triggers are disabled/)

            const status = await run("auto status")
            assert.match(status, /Effective state: off \(session override\)/)
            assert.match(status, /250,000 tokens \(session override\)/)
            assert.match(status, /75% \(session override\)/)
            assert.match(status, /2 assistant responses remaining/)

            const loaded = await loadSessionState(sessionId, logger, messages as any)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.autoCompressionEnabledOverride, false)
            assert.equal(loaded.state.autoCompressionTokenThresholdOverride, 250_000)
            assert.equal(loaded.state.autoCompressionContextWindowRatioOverride, 0.75)
            assert.equal(loaded.state.compressionCooldownAfterMessageId, "compress-anchor")

            const reset = await run("auto reset")
            assert.equal(reset, "Defaults reset to 350,000 tokens and 90% threshold.")
            assert.equal(state.autoCompressionEnabledOverride, false)
            assert.equal(state.autoCompressionTokenThresholdOverride, undefined)
            assert.equal(state.autoCompressionContextWindowRatioOverride, undefined)
            assert.equal(state.compressionCooldownAfterMessageId, "compress-anchor")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("rejects invalid values without changing live or persisted settings", async () => {
        const sessionId = `session-auto-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const messages = [userMessage("u1", sessionId)]
        const { stateManager, run } = createHarness(sessionId, messages)

        try {
            await run("auto threshold 123")
            const state = stateManager.get(sessionId)
            const lastUpdated = state.persistedLastUpdated

            for (const invalid of [
                "auto threshold 0",
                "auto threshold -1",
                "auto threshold 1.5",
                "auto threshold 9007199254740992",
                "auto threshold 2 extra",
                "auto ratio 0",
                "auto ratio 100",
                "auto ratio 1.5",
                "auto ratio",
                "auto surprise",
            ]) {
                assert.match(await run(invalid), /^Usage:/)
            }

            assert.equal(state.autoCompressionTokenThresholdOverride, 123)
            assert.equal(state.autoCompressionContextWindowRatioOverride, undefined)
            assert.equal(state.persistedLastUpdated, lastUpdated)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("keeps sessions isolated and serializes overlapping setting writes", async () => {
        const sessionId = `session-auto-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const otherSessionId = `${sessionId}-other`
        await cleanupSessionFile(sessionId)
        await cleanupSessionFile(otherSessionId)
        const messages = [userMessage("u1", sessionId)]
        const { stateManager, run } = createHarness(sessionId, messages)

        try {
            await Promise.all([run("auto threshold 222222"), run("auto off")])

            const loaded = await loadSessionState(sessionId, logger)
            assert.equal(loaded.status, "loaded")
            if (loaded.status !== "loaded") throw new Error("expected persisted state")
            assert.equal(loaded.state.autoCompressionTokenThresholdOverride, 222_222)
            assert.equal(loaded.state.autoCompressionEnabledOverride, false)

            const other = stateManager.get(otherSessionId)
            assert.equal(other.autoCompressionEnabledOverride, undefined)
            assert.equal(other.autoCompressionTokenThresholdOverride, undefined)
        } finally {
            await cleanupSessionFile(sessionId)
            await cleanupSessionFile(otherSessionId)
        }
    })

    it("keeps the global kill switch authoritative and reports failed writes honestly", async () => {
        const disabledSessionId = `session-auto-global-off-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const failingSessionId = `session-auto-save-fails/${Date.now()}-${Math.random().toString(36).slice(2)}`
        const globallyDisabled = {
            ...config,
            autoCompression: { ...config.autoCompression, enabled: false },
        }
        const disabled = createHarness(
            disabledSessionId,
            [userMessage("u1", disabledSessionId)],
            globallyDisabled,
        )
        const failing = createHarness(
            failingSessionId,
            [userMessage("u1", failingSessionId)],
        )

        try {
            assert.match(await disabled.run("auto on"), /disabled globally/)
            assert.match(await disabled.run("auto off"), /already off \(global config\)/)
            assert.equal(
                disabled.stateManager.get(disabledSessionId).autoCompressionEnabledOverride,
                undefined,
            )
            assert.match(await disabled.run("auto"), /Global availability: disabled by config/)

            assert.match(await failing.run("auto off"), /could not be saved/)
            assert.equal(
                failing.stateManager.get(failingSessionId).autoCompressionEnabledOverride,
                undefined,
            )
        } finally {
            await cleanupSessionFile(disabledSessionId)
        }
    })

    it("does not replace unreadable persisted state with a session override", async () => {
        const sessionId = `session-auto-load-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const filePath = getSessionFilePath(sessionId)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, "{invalid-json", "utf8")
        const { stateManager, run } = createHarness(sessionId, [userMessage("u1", sessionId)])

        try {
            const response = await run("auto off")

            assert.match(response, /saved session state could not be loaded/)
            assert.equal(
                stateManager.get(sessionId).autoCompressionEnabledOverride,
                undefined,
            )
            assert.equal(await readFile(filePath, "utf8"), "{invalid-json")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })
})
