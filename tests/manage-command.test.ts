import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { extractManageCommandResidual, handleManageCommand } from "../lib/commands/manage.ts"
import type { PluginConfig } from "../lib/config.ts"
import { createSessionState, SessionStateManager } from "../lib/state/state.ts"

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
    commands: {
        enabled: true,
        protectedTools: [],
    },
    autoCompression: {
        enabled: true,
        contextWindowRatio: 0.9,
        tokenThreshold: 300_000,
    },
    turnProtection: {
        enabled: false,
        turns: 0,
    },
    protectedFilePatterns: [],
    tools: {
        settings: {
            protectedTools: [],
        },
        compress: {
            permission: "allow",
            showCompression: false,
        },
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

const createUserMessage = (sessionID: string) => ({
    info: {
        id: "m1",
        role: "user" as const,
        sessionID,
        agent: "agent-test",
        model: {
            providerID: "openai",
            modelID: "gpt-5.4",
        },
        time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "Please manage context" }],
})

const createPromptResponse = (assistantId: string, userId: string) => ({
    data: {
        info: {
            id: assistantId,
            role: "assistant",
            parentID: userId,
        },
        parts: [],
    },
})

const insertLiveMessageById = <T extends { id: string }>(messages: T[], message: T) => {
    let low = 0
    let high = messages.length
    while (low < high) {
        const mid = Math.floor((low + high) / 2)
        if (messages[mid].id < message.id) {
            low = mid + 1
        } else {
            high = mid
        }
    }
    messages.splice(low, 0, message)
}

describe("handleManageCommand", () => {
    it("does not open a management turn when compress is denied", async () => {
        const sessionId = `session-manage-tool-denied-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true
        let promptCalls = 0
        const toasts: any[] = []
        const client = {
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input)
                },
            },
            session: {
                prompt: async () => {
                    promptCalls++
                },
            },
        }
        const deniedConfig: PluginConfig = {
            ...config,
            tools: {
                ...config.tools,
                compress: { ...config.tools.compress, permission: "deny" },
            },
        }

        await handleManageCommand({
            client,
            stateManager: new SessionStateManager(),
            state,
            config: deniedConfig,
            logger,
            sessionId,
            messages: [createUserMessage(sessionId)] as any,
            arguments: "manage",
        })

        assert.equal(promptCalls, 0)
        assert.equal(state.managementTurns.length, 0)
        assert.equal(toasts.length, 1)
        assert.match(toasts[0].body.message, /Enable the compression tool/)
    })

    it("sends a self-contained one-call reminder and anchors cleanup to the generated prompt message ID", async () => {
        const sessionId = `session-manage-command-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true

        let promptBody: any
        const generatedAssistantId = "msg_01900000000000000000000002"
        const client = {
            session: {
                prompt: async (input: any) => {
                    promptBody = input.body
                    // Real OpenCode threads the assistant reply's parentID to the
                    // literal messageID we supplied here.
                    return createPromptResponse(generatedAssistantId, input.body.messageID)
                },
            },
        }

        try {
            await handleManageCommand({
                client,
                stateManager: new SessionStateManager(),
                state,
                config,
                logger,
                sessionId,
                messages: [createUserMessage(sessionId)] as any,
                arguments: "manage",
            })

            const parts: any[] = promptBody.parts
            const reminderText = parts[0].text
            const fullPayload = parts.map((part) => part.text).join("\n\n")
            assert.match(reminderText, /<system-reminder>/)
            assert.match(reminderText, /Call `compress` once with `summary` and `topic`/)
            assert.match(reminderText, /A failure means nothing was compressed/)
            assert.doesNotMatch(reminderText, /compress_map|context-map/i)
            assert.doesNotMatch(fullPayload, /compress_map|context-map/i)
            assert.equal(parts.length, 1)

            assert.match(promptBody.messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
            assert.equal(state.managementTurns.length, 1)
            assert.equal(state.managementTurns[0].triggerMessageId, promptBody.messageID)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("persists the generated trigger ID even when the prompt result's parentID points at a later notification", async () => {
        // Reproduces the `Slice 3 dashboard shell handoff` failure pattern: the assistant
        // reply's parentID ends up pointing at a mid-turn ignored status notification
        // instead of the actual manage prompt that started the turn. The generated
        // messageID we pass through must remain the source of truth regardless.
        const sessionId = `session-manage-slice3-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true

        const misleadingNotificationId = "msg_01900000000000000000000099"
        const generatedAssistantId = "msg_01900000000000000000000011"
        let promptBody: any
        const client = {
            session: {
                prompt: async (input: any) => {
                    promptBody = input.body
                    return createPromptResponse(generatedAssistantId, misleadingNotificationId)
                },
            },
        }

        try {
            await handleManageCommand({
                client,
                stateManager: new SessionStateManager(),
                state,
                config,
                logger,
                sessionId,
                messages: [createUserMessage(sessionId)] as any,
                arguments: "manage",
            })

            assert.equal(state.managementTurns.length, 1)
            assert.ok(promptBody.messageID, "expected a generated messageID to be sent")
            assert.equal(state.managementTurns[0].triggerMessageId, promptBody.messageID)
            assert.notEqual(state.managementTurns[0].triggerMessageId, misleadingNotificationId)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("uses the assigned prompt ID that preserves live-render ordering", async () => {
        const sessionId = `session-manage-render-order-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true

        const generatedAssistantId = "msg_zzzzzzzzzzzzzzzzzzzzzzzzzz"
        let promptBody: any
        const client = {
            session: {
                prompt: async (input: any) => {
                    promptBody = input.body
                    return createPromptResponse(generatedAssistantId, input.body.messageID)
                },
            },
        }

        try {
            await handleManageCommand({
                client,
                stateManager: new SessionStateManager(),
                state,
                config,
                logger,
                sessionId,
                messages: [createUserMessage(sessionId)] as any,
                arguments: "manage",
            })

            const triggerMessageId = state.managementTurns[0].triggerMessageId
            assert.equal(promptBody.messageID, triggerMessageId)
            assert.ok(
                triggerMessageId > "msg_f36d1953e001LLAN53Qcy9ZdYU",
                "generated manage prompt ID must sort after recent OpenCode msg_f... IDs",
            )

            const liveMessages: Array<{ id: string; role: "user" | "assistant"; parentID?: string }> = []
            insertLiveMessageById(liveMessages, { id: triggerMessageId, role: "user" })
            insertLiveMessageById(liveMessages, {
                id: generatedAssistantId,
                role: "assistant",
                parentID: triggerMessageId,
            })

            assert.deepEqual(
                liveMessages.map((message) => message.id),
                [triggerMessageId, generatedAssistantId],
            )
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("shows visible feedback and does not prompt when cleanup state cannot be saved", async () => {
        const sessionId = `session-manage-save-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const state = createSessionState()
        state.initialized = true
        state.persistenceSynchronized = true

        const toasts: any[] = []
        let promptCalls = 0
        const client = {
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input)
                },
            },
            session: {
                prompt: async () => {
                    promptCalls++
                },
            },
        }

        await handleManageCommand({
            client,
            stateManager: new SessionStateManager(),
            state,
            config,
            logger,
            sessionId,
            messages: [createUserMessage(sessionId)] as any,
            arguments: "manage",
        })

        assert.equal(promptCalls, 0)
        assert.equal(state.managementTurns.length, 0)
        assert.equal(toasts.length, 1)
        assert.match(toasts[0].body.message, /Compression management could not start/)
    })

    it("does not start management when saved session state was not synchronized", async () => {
        const sessionId = `session-manage-load-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        const toasts: any[] = []
        let promptCalls = 0
        const client = {
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input)
                },
            },
            session: {
                prompt: async () => {
                    promptCalls++
                },
            },
        }

        await handleManageCommand({
            client,
            stateManager: new SessionStateManager(),
            state,
            config,
            logger,
            sessionId,
            messages: [createUserMessage(sessionId)] as any,
            arguments: "manage",
        })

        assert.equal(promptCalls, 0)
        assert.equal(state.managementTurns.length, 0)
        assert.equal(toasts.length, 1)
        assert.match(toasts[0].body.message, /saved session state could not be loaded/)
    })

    it("shows visible feedback when the manage prompt throws", async () => {
        const sessionId = `session-manage-prompt-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true

        const toasts: any[] = []
        let promptCalls = 0
        const client = {
            tui: {
                showToast: async (input: any) => {
                    toasts.push(input)
                },
            },
            session: {
                prompt: async () => {
                    promptCalls++
                    throw new Error("agent unavailable")
                },
            },
        }

        try {
            await handleManageCommand({
                client,
                stateManager: new SessionStateManager(),
                state,
                config,
                logger,
                sessionId,
                messages: [createUserMessage(sessionId)] as any,
                arguments: "manage",
            })

            assert.equal(promptCalls, 1)
            assert.equal(state.managementTurns.length, 0)
            assert.equal(toasts.length, 1)
            assert.match(toasts[0].body.message, /agent unavailable/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("extracts mixed-content text after the manage invocation", () => {
        assert.equal(extractManageCommandResidual("manage"), undefined)
        assert.equal(extractManageCommandResidual("manage please compress the old context now"), undefined)
        assert.equal(
            extractManageCommandResidual("manage Also, the launch window is June."),
            "Also, the launch window is June.",
        )
        assert.equal(
            extractManageCommandResidual("manage please compress completed work; the launch window is June."),
            "the launch window is June.",
        )
        assert.equal(
            extractManageCommandResidual("manage please compress completed work and the launch window is June."),
            "the launch window is June.",
        )
    })
})
