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
    protectedTurns: 3,
    commands: { enabled: true },
    autoCompression: {
        enabled: true,
        contextWindowRatio: 0.9,
        tokenThreshold: 300_000,
    },
    reportNudge: { enabled: false, tokenInterval: 100_000 },
    tools: {
        compress: { permission: "allow", showCompression: false },
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

const handlerReport = (
    handler: ReturnType<typeof createCommandExecuteHandler>,
    sessionID: string,
    output: { parts: unknown[]; cancelled: boolean },
) => handler({ command: "compress", sessionID, arguments: "report" }, output as any)

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
            assert.match(ignoredMessages[0] ?? "", /Compress commands/)
            assert.match(ignoredMessages[0] ?? "", /compress squash/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("prompts the report checkpoint on demand only while the nudge feature is enabled", async () => {
        const sessionId = `session-report-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const stateManager = new SessionStateManager()
        stateManager.get(sessionId).initialized = true

        const promptTexts: string[] = []
        const client = {
            session: {
                messages: async () => [createUserMessage(sessionId)],
                prompt: async (input: any) => {
                    promptTexts.push(input.body?.parts?.[0]?.text ?? input.parts?.[0]?.text ?? "")
                    return { data: { info: { id: "ignored" } } }
                },
            },
            tui: { showToast: async () => undefined },
        }

        try {
            const enabled = createCommandExecuteHandler(client, stateManager, logger, {
                ...config,
                reportNudge: { enabled: true, tokenInterval: 100_000 },
            })
            const enabledOutput = { parts: [{ type: "text", text: "placeholder" }], cancelled: false }
            await handlerReport(enabled, sessionId, enabledOutput)

            assert.equal(enabledOutput.cancelled, true)
            assert.equal(promptTexts.length, 1)
            assert.match(promptTexts[0], /HANDOFF REPORT CHECKPOINT/)

            const disabled = createCommandExecuteHandler(client, stateManager, logger, config)
            const disabledOutput = { parts: [{ type: "text", text: "placeholder" }], cancelled: false }
            await handlerReport(disabled, sessionId, disabledOutput)

            // Falls through to help, which omits the command it cannot run.
            assert.equal(promptTexts.length, 2)
            assert.match(promptTexts[1], /Compress commands/)
            assert.doesNotMatch(promptTexts[1], /compress report/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("surfaces a resolved prompt error instead of logging the report checkpoint as sent", async () => {
        const sessionId = `session-report-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true

        const prompts: string[] = []
        const toasts: any[] = []
        const client = {
            session: {
                messages: async () => [createUserMessage(sessionId)],
                // The SDK resolves transport failures rather than throwing.
                prompt: async (input: any) => {
                    prompts.push(input.body?.parts?.[0]?.text ?? input.parts?.[0]?.text ?? "")
                    return { error: { message: "session unavailable" }, data: undefined }
                },
            },
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input.body ?? input)
                    return undefined
                },
            },
        }

        try {
            const handler = createCommandExecuteHandler(client, stateManager, logger, {
                ...config,
                reportNudge: { enabled: true, tokenInterval: 100_000 },
            })
            const output = { parts: [{ type: "text", text: "placeholder" }], cancelled: false }
            await handlerReport(handler, sessionId, output)

            // One attempt only: the failure notice must not go back through the transport that
            // just failed.
            assert.equal(prompts.length, 1)
            assert.match(prompts[0], /HANDOFF REPORT CHECKPOINT/)
            assert.equal(toasts.length, 1)
            assert.equal(toasts[0].variant, "error")
            assert.match(toasts[0].message, /session unavailable/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("treats a provider-rejected assistant turn as a failed checkpoint, not a sent one", async () => {
        const sessionId = `session-report-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true

        const toasts: any[] = []
        const client = {
            session: {
                messages: async () => [createUserMessage(sessionId)],
                // HTTP succeeded; the assistant turn itself carries the failure. The flat client
                // shape returns that message without the `data` envelope.
                prompt: async () => ({ info: { id: "m1", error: new Error("ProviderError: 500") } }),
            },
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input.body ?? input)
                    return undefined
                },
            },
        }

        try {
            const handler = createCommandExecuteHandler(client, stateManager, logger, {
                ...config,
                reportNudge: { enabled: true, tokenInterval: 100_000 },
            })
            const output = { parts: [{ type: "text", text: "placeholder" }], cancelled: false }
            await handlerReport(handler, sessionId, output)

            assert.equal(toasts.length, 1)
            assert.match(toasts[0].message, /ProviderError/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("reports a thrown prompt failure rather than letting it escape the command", async () => {
        const sessionId = `session-report-throw-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true

        const toasts: any[] = []
        const client = {
            session: {
                messages: async () => [createUserMessage(sessionId)],
                prompt: async () => {
                    throw new Error("prompt API unavailable")
                },
            },
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input.body ?? input)
                    return undefined
                },
            },
        }

        try {
            const handler = createCommandExecuteHandler(client, stateManager, logger, {
                ...config,
                reportNudge: { enabled: true, tokenInterval: 100_000 },
            })
            const output = { parts: [{ type: "text", text: "placeholder" }], cancelled: false }
            await handlerReport(handler, sessionId, output)

            assert.equal(output.cancelled, true)
            assert.equal(toasts.length, 1)
            assert.match(toasts[0].message, /prompt API unavailable/)
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
        let capturedMessageId: string | undefined
        const client = {
            session: {
                messages: async () => [createUserMessage(sessionId)],
                prompt: async (input: any) => {
                    promptCalls++
                    const text = input.body?.parts?.[0]?.text ?? input.parts?.[0]?.text ?? ""
                    assert.match(text, /CONTEXT MANAGEMENT REQUESTED/)
                    capturedMessageId = input.body?.messageID
                    // Simulate the observed Slice-3 bug: the assistant reply's parentID
                    // ends up pointing at a mid-turn notification, not the manage prompt.
                    // The generated messageID we sent must still be the cleanup anchor.
                    return {
                        data: {
                            info: {
                                id: "assistant-1",
                                role: "assistant",
                                parentID: "user-later-notification-1",
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
            assert.ok(capturedMessageId, "expected a generated messageID to be sent")
            assert.equal(state.managementTurns[0].triggerMessageId, capturedMessageId)
            assert.notEqual(state.managementTurns[0].triggerMessageId, "user-later-notification-1")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("routes squash once and suppresses the default command prompt", async () => {
        const sessionId = `session-squash-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const stateManager = new SessionStateManager()
        const state = stateManager.get(sessionId)
        state.initialized = true
        const messages = [createUserMessage(sessionId, "block-0"), createUserMessage(sessionId, "block-1")]
        state.compressed.messageIds = new Set(["block-0", "block-1"])
        state.compressSummaries = [
            { anchorMessageId: "block-0", messageIds: ["block-0"], summary: "First" },
            { anchorMessageId: "block-1", messageIds: ["block-1"], summary: "Second" },
        ]
        let promptCalls = 0
        const client = {
            session: {
                messages: async () => messages,
                prompt: async (input: any) => {
                    promptCalls++
                    assert.match(input.body.parts[0].text, /CONTEXT SQUASH REQUESTED/)
                    return { data: { info: { id: "assistant-squash", parentID: input.body.messageID } } }
                },
            },
            tui: { showToast: async () => undefined },
        }

        try {
            const handler = createCommandExecuteHandler(client, stateManager, logger, config)
            const output = { parts: [{ type: "text", text: "placeholder" }], cancelled: false }
            await handler(
                { command: "compress", sessionID: sessionId, arguments: "squash keep b0" },
                output,
            )
            assert.equal(output.cancelled, true)
            assert.deepEqual(output.parts, [])
            assert.equal(promptCalls, 1)
            assert.equal(state.managementTurns[0].source, "squash")
            assert.equal(state.managementTurns[0].retainedText, "keep b0")
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })
})
