import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { createChatMessageTransformHandler } from "../lib/hooks.ts"
import { Logger } from "../lib/logger.ts"
import { COMPRESS_SUMMARY_PREFIX } from "../lib/messages/utils.ts"
import { saveSessionState } from "../lib/state/persistence.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import type { PluginConfig } from "../lib/config.ts"

const logger = new Logger(false)

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
            showCompression: true,
        },
        compress_map: {
            permission: "allow",
        },
    },
}

const client = {
    session: {
        get: async () => ({ data: {} }),
    },
}

const createMessage = (id: string, sessionID: string, role: "user" | "assistant") => ({
    info: {
        id,
        role,
        sessionID,
        agent: "agent-test",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        time: { created: Date.now() },
    },
    parts: role === "user" ? [{ type: "text", text: `message-${id}` }] : [],
})

const cloneMessages = <T>(value: T): T => structuredClone(value)

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

describe("session-scoped compress overlay", () => {
    it("reloads persisted compression state for a stale second instance", async () => {
        const sessionId = `session-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                createMessage("m1", sessionId, "user"),
                createMessage("m2", sessionId, "assistant"),
                createMessage("m3", sessionId, "assistant"),
            ]

            const managerA = new SessionStateManager()
            const managerB = new SessionStateManager()
            const handlerB = createChatMessageTransformHandler(
                client,
                managerB,
                logger,
                config,
                "/tmp/instance-b",
            )

            const firstOutput = { messages: cloneMessages(rawMessages) as any }
            await handlerB({}, firstOutput)
            assert.deepEqual(
                firstOutput.messages.map((message: any) => message.info.id),
                ["m1", "m2", "m3"],
            )

            const stateA = managerA.get(sessionId)
            stateA.compressed.messageIds = new Set(["m2", "m3"])
            stateA.compressSummaries = [
                {
                    anchorMessageId: "m2",
                    messageIds: ["m2", "m3"],
                    summary: "compressed block summary",
                },
            ]
            await saveSessionState(stateA, logger)

            const secondOutput = { messages: cloneMessages(rawMessages) as any }
            await handlerB({}, secondOutput)

            assert.deepEqual(
                secondOutput.messages.map((message: any) => message.info.id),
                ["m1", secondOutput.messages[1].info.id],
            )
            assert.equal(
                secondOutput.messages[1].parts[0].text.startsWith(COMPRESS_SUMMARY_PREFIX),
                true,
            )
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("hydrates multiple persisted summaries after instance recreation", async () => {
        const sessionId = `session-overlay-multi-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                createMessage("m1", sessionId, "user"),
                createMessage("m2", sessionId, "assistant"),
                createMessage("m3", sessionId, "assistant"),
                createMessage("m4", sessionId, "user"),
                createMessage("m5", sessionId, "assistant"),
                createMessage("m6", sessionId, "assistant"),
            ]

            const managerA = new SessionStateManager()
            const stateA = managerA.get(sessionId)
            stateA.compressed.messageIds = new Set(["m2", "m3", "m5", "m6"])
            stateA.compressSummaries = [
                {
                    anchorMessageId: "m2",
                    messageIds: ["m2", "m3"],
                    summary: "first block",
                },
                {
                    anchorMessageId: "m5",
                    messageIds: ["m5", "m6"],
                    summary: "second block",
                },
            ]
            await saveSessionState(stateA, logger)

            const recreatedManager = new SessionStateManager()
            const handler = createChatMessageTransformHandler(
                client,
                recreatedManager,
                logger,
                config,
                "/tmp/recreated-instance",
            )
            const output = { messages: cloneMessages(rawMessages) as any }
            await handler({}, output)

            const summaryMessages = output.messages.filter(
                (message: any) => message.parts[0]?.text?.startsWith(COMPRESS_SUMMARY_PREFIX),
            )
            assert.equal(summaryMessages.length, 2)
            assert.deepEqual(
                output.messages.map((message: any) => message.info.role),
                ["user", "user", "user", "user"],
            )
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("leaves sessions without persisted compression unchanged", async () => {
        const sessionId = `session-overlay-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const rawMessages = [
                createMessage("m1", sessionId, "user"),
                createMessage("m2", sessionId, "assistant"),
            ]
            const manager = new SessionStateManager()
            const handler = createChatMessageTransformHandler(
                client,
                manager,
                logger,
                config,
                "/tmp/clean-instance",
            )
            const output = { messages: cloneMessages(rawMessages) as any }

            await handler({}, output)

            assert.deepEqual(output.messages, rawMessages)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })
})
