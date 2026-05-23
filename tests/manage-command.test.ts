import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { extractManageCommandResidual, handleManageCommand } from "../lib/commands/manage.ts"
import type { PluginConfig } from "../lib/config.ts"
import { createSessionState } from "../lib/state/state.ts"

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
    commands: {
        enabled: true,
        protectedTools: [],
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
        compress_map: {
            permission: "allow",
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
    it("sends a lean reminder without embedding the context map", async () => {
        const sessionId = `session-manage-command-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true

        let payload = ""
        let promptBody: any
        const generatedUserId = "msg_01900000000000000000000001"
        const generatedAssistantId = "msg_01900000000000000000000002"
        const client = {
            session: {
                prompt: async (input: any) => {
                    payload = input.body.parts[0].text
                    promptBody = input.body
                    return createPromptResponse(generatedAssistantId, generatedUserId)
                },
            },
        }

        try {
            await handleManageCommand({
                client,
                state,
                config,
                logger,
                sessionId,
                messages: [createUserMessage(sessionId)] as any,
                arguments: "manage",
            })

            const nonEmptyLines = payload.split("\n").filter((line) => line.trim().length > 0)

            assert.match(payload, /<system-reminder>/)
            assert.match(payload, /compress_map/)
            assert.match(payload, /compress/)
            assert.doesNotMatch(payload, /<compress-context-map>/)
            assert.equal(promptBody.messageID, undefined)
            assert.equal(state.managementTurns.length, 1)
            assert.equal(state.managementTurns[0].triggerMessageId, generatedUserId)
            assert.ok(nonEmptyLines.length <= 18, `expected <= 18 non-empty lines, got ${nonEmptyLines.length}`)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("uses the OCO-assigned prompt ID that preserves live-render ordering", async () => {
        const sessionId = `session-manage-render-order-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true

        const generatedUserId = "msg_01900000000000000000000010"
        const generatedAssistantId = "msg_01900000000000000000000011"
        let promptBody: any
        const client = {
            session: {
                prompt: async (input: any) => {
                    promptBody = input.body
                    const userId = input.body.messageID ?? generatedUserId
                    return createPromptResponse(generatedAssistantId, userId)
                },
            },
        }

        try {
            await handleManageCommand({
                client,
                state,
                config,
                logger,
                sessionId,
                messages: [createUserMessage(sessionId)] as any,
                arguments: "manage",
            })

            const triggerMessageId = state.managementTurns[0].triggerMessageId
            const liveMessages: Array<{ id: string; role: "user" | "assistant"; parentID?: string }> = []
            insertLiveMessageById(liveMessages, { id: triggerMessageId, role: "user" })
            insertLiveMessageById(liveMessages, {
                id: generatedAssistantId,
                role: "assistant",
                parentID: triggerMessageId,
            })

            assert.deepEqual(
                liveMessages.map((message) => message.id),
                [generatedUserId, generatedAssistantId],
            )
            assert.equal(promptBody.messageID, undefined)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("shows visible feedback and does not prompt when cleanup state cannot be saved", async () => {
        const sessionId = `session-manage-save-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const state = createSessionState()
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

    it("shows visible feedback when the manage prompt throws", async () => {
        const sessionId = `session-manage-prompt-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
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
                    throw new Error("agent unavailable")
                },
            },
        }

        try {
            await handleManageCommand({
                client,
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
