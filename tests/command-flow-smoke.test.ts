import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { createCommandExecuteHandler } from "../lib/hooks.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import type { PluginConfig } from "../lib/config.ts"

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
    const filePath = getSessionFilePath(sessionId)
    if (existsSync(filePath)) {
        await rm(filePath)
    }
}

const createUserMessage = (sessionId: string, id = "m1") => ({
    info: {
        id,
        role: "user" as const,
        sessionID: sessionId,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "hello" }],
})

describe("compress command smoke flow", () => {
    it("handles helper commands without default prompt execution when cancellation is supported", async () => {
        const sessionId = `session-command-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true

        let promptCalls = 0
        const ignoredMessages: string[] = []
        const client = {
            session: {
                messages: async () => [createUserMessage(sessionId)],
                prompt: async (input: any) => {
                    promptCalls++
                    const text = input.body?.parts?.[0]?.text ?? input.parts?.[0]?.text
                    if (text) ignoredMessages.push(text)
                    return { data: { info: { id: "ignored" } } }
                },
            },
            tui: {
                showToast: async () => undefined,
            },
        }

        try {
            const handler = createCommandExecuteHandler(client, stateManager, logger, config)
            const output = { parts: [{ type: "text", text: "placeholder" }], cancelled: false }

            await handler({ command: "compress", sessionID: sessionId, arguments: "help" }, output)

            assert.equal(output.cancelled, true)
            assert.deepEqual(output.parts, [])
            assert.equal(promptCalls, 1)
            assert.match(ignoredMessages[0] ?? "", /Compress Commands/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("starts manage flow once and suppresses the default command prompt when supported", async () => {
        const sessionId = `session-manage-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true

        let promptCalls = 0
        const client = {
            session: {
                messages: async () => [createUserMessage(sessionId)],
                prompt: async (input: any) => {
                    promptCalls++
                    const text = input.body?.parts?.[0]?.text ?? input.parts?.[0]?.text ?? ""
                    assert.match(text, /CONTEXT MANAGEMENT REQUESTED/)
                    return {
                        data: {
                            info: {
                                id: "assistant-1",
                                role: "assistant",
                                parentID: "user-manage-1",
                            },
                        },
                    }
                },
            },
            tui: {
                showToast: async () => undefined,
            },
        }

        try {
            const handler = createCommandExecuteHandler(client, stateManager, logger, config)
            const output = { parts: [{ type: "text", text: "placeholder" }], cancelled: false }

            await handler({ command: "compress", sessionID: sessionId, arguments: "manage" }, output)

            assert.equal(output.cancelled, true)
            assert.equal(promptCalls, 1)
            assert.equal(state.managementTurns.length, 1)
            assert.equal(state.managementTurns[0].triggerMessageId, "user-manage-1")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })
})
