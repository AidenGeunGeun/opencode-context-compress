import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { PluginConfig } from "../lib/config.ts"
import { createChatMessageTransformHandler } from "../lib/hooks.ts"
import { Logger } from "../lib/logger.ts"
import { applyCompressTransforms } from "../lib/messages/compress-transform.ts"
import { COMPRESS_SUMMARY_PREFIX } from "../lib/messages/utils.ts"
import { saveSessionState } from "../lib/state/persistence.ts"
import { createSessionState, SessionStateManager } from "../lib/state/state.ts"
import type { SessionState, WithParts } from "../lib/state/types.ts"

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
            showCompression: false,
        },
        compress_map: {
            permission: "allow",
        },
    },
}

let timeCounter = 1_700_000_000_000

const textMessage = (id: string, sessionID: string, text: string, role: "user" | "assistant" = "user") => ({
    info: {
        id,
        role,
        sessionID,
        agent: "agent-test",
        model: {
            providerID: "openai",
            modelID: "gpt-5.4",
        },
        time: { created: timeCounter++ },
    },
    parts: [{ id: `part-${id}`, sessionID, messageID: id, type: "text", text }],
})

const ignoredUserMessage = (id: string, sessionID: string, text: string) => ({
    info: {
        id,
        role: "user" as const,
        sessionID,
        agent: "agent-test",
        model: {
            providerID: "openai",
            modelID: "gpt-5.4",
        },
        time: { created: timeCounter++ },
    },
    parts: [{ id: `part-${id}`, sessionID, messageID: id, type: "text", text, ignored: true }],
})

const toolMessage = (
    id: string,
    sessionID: string,
    tool: string,
    output: string,
    callID: string = `call-${id}`,
    status: "completed" | "error" = "completed",
) => ({
    info: {
        id,
        role: "assistant" as const,
        sessionID,
        agent: "agent-test",
        model: {
            providerID: "openai",
            modelID: "gpt-5.4",
        },
        time: { created: timeCounter++ },
    },
    parts: [
        {
            id: `part-${id}`,
            sessionID,
            messageID: id,
            type: "tool",
            tool,
            callID,
            state:
                status === "completed"
                    ? {
                          status,
                          input: { from: 1, to: 2, summary: "summary", topic: "topic" },
                          output,
                      }
                    : {
                          status,
                          input: { from: 1, to: 2 },
                          error: output,
                      },
        },
    ],
})

const cloneMessages = <T>(value: T): T => structuredClone(value)

const createState = (sessionId: string): SessionState => {
    const state = createSessionState()
    state.sessionId = sessionId
    state.initialized = true
    return state
}

const serializeProviderPrefix = (messages: WithParts[], firstActiveTailMessageId: string): string => {
    const activeTailIndex = messages.findIndex((message) => message.info.id === firstActiveTailMessageId)
    const prefix = activeTailIndex === -1 ? messages : messages.slice(0, activeTailIndex)
    return JSON.stringify(prefix)
}

const messageTexts = (messages: WithParts[]): string => JSON.stringify(messages)

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

describe("compress-turn machinery cleanup", () => {
    it("keeps blocks and removes completed management machinery after compression", () => {
        const sessionId = "session-cleanup-compressed"
        const state = createState(sessionId)
        state.compressed.messageIds = new Set(["work-user", "work-assistant"])
        state.compressSummaries = [
            {
                anchorMessageId: "work-user",
                messageIds: ["work-user", "work-assistant"],
                summary: "Durable block summary.",
                topic: "Durable Block",
            },
        ]
        state.managementTurns = [{ triggerMessageId: "manage-1" }]

        const messages = [
            textMessage("work-user", sessionId, "Old request"),
            textMessage("work-assistant", sessionId, "Old answer", "assistant"),
            textMessage("manage-1", sessionId, "<system-reminder>/compress manage</system-reminder>"),
            textMessage("manage-reason", sessionId, "I will inspect the map", "assistant"),
            toolMessage("manage-map", sessionId, "compress_map", "<compress-context-map>stale</compress-context-map>"),
            toolMessage("manage-compress", sessionId, "compress", "Compressed range\n\n<compress-context-map>updated</compress-context-map>"),
            textMessage("manage-close", sessionId, "Compressed into one block", "assistant"),
            textMessage("next-user", sessionId, "Next normal request"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.equal(messages.length, 2)
        assert.equal(messages[0].parts[0].text.startsWith(COMPRESS_SUMMARY_PREFIX), true)
        assert.match(messages[0].parts[0].text, /Durable block summary\./)
        assert.equal(messages[1].info.id, "next-user")

        const serialized = messageTexts(messages)
        assert.doesNotMatch(serialized, /compress manage/)
        assert.doesNotMatch(serialized, /compress-context-map/)
        assert.doesNotMatch(serialized, /I will inspect the map/)
        assert.doesNotMatch(serialized, /Compressed into one block/)
        assert.doesNotMatch(serialized, /call-manage-map/)
        assert.doesNotMatch(serialized, /call-manage-compress/)
    })

    it("removes completed management machinery when no compression happened", () => {
        const sessionId = "session-cleanup-no-compression"
        const state = createState(sessionId)
        state.managementTurns = [{ triggerMessageId: "manage-noop" }]
        const messages = [
            textMessage("normal-before", sessionId, "Normal context before"),
            textMessage("manage-noop", sessionId, "<system-reminder>/compress manage</system-reminder>"),
            textMessage("noop-reason", sessionId, "Nothing to compress", "assistant"),
            toolMessage("noop-map", sessionId, "compress_map", "<compress-context-map>noop</compress-context-map>"),
            textMessage("normal-after", sessionId, "Normal context after"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), ["normal-before", "normal-after"])
        assert.doesNotMatch(messageTexts(messages), /Nothing to compress|compress-context-map|compress manage/)
    })

    it("removes completed management machinery from failed or aborted turns", () => {
        const sessionId = "session-cleanup-failed"
        const state = createState(sessionId)
        state.managementTurns = [{ triggerMessageId: "manage-failed" }]
        const messages = [
            textMessage("pre", sessionId, "Before failure"),
            textMessage("manage-failed", sessionId, "<system-reminder>/compress manage</system-reminder>"),
            toolMessage("failed-map", sessionId, "compress_map", "Tool failed while reading map", "call-failed-map", "error"),
            textMessage("failed-close", sessionId, "I could not finish compression", "assistant"),
            textMessage("post", sessionId, "After failure"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), ["pre", "post"])
        assert.doesNotMatch(messageTexts(messages), /Tool failed|could not finish|compress manage/)
    })

    it("preserves inter-compress conversation across many management turns without residue", () => {
        const sessionId = "session-cleanup-many"
        const state = createState(sessionId)
        const messages: any[] = []

        for (let i = 0; i < 8; i++) {
            const workUser = `work-u-${i}`
            const workAssistant = `work-a-${i}`
            const manage = `manage-${i}`
            messages.push(textMessage(workUser, sessionId, `Completed phase ${i} request`))
            messages.push(textMessage(workAssistant, sessionId, `Completed phase ${i} answer`, "assistant"))
            messages.push(textMessage(manage, sessionId, `<system-reminder>/compress manage ${i}</system-reminder>`))
            messages.push(toolMessage(`map-${i}`, sessionId, "compress_map", `<compress-context-map>${i}</compress-context-map>`))
            messages.push(toolMessage(`compress-${i}`, sessionId, "compress", `Compressed range ${i}`))
            messages.push(textMessage(`between-u-${i}`, sessionId, `Inter-compress user ${i}`))
            messages.push(textMessage(`between-a-${i}`, sessionId, `Inter-compress assistant ${i}`, "assistant"))

            state.compressed.messageIds.add(workUser)
            state.compressed.messageIds.add(workAssistant)
            state.compressSummaries.push({
                anchorMessageId: workUser,
                messageIds: [workUser, workAssistant],
                summary: `Block summary ${i}`,
                topic: `Block ${i}`,
            })
            state.managementTurns.push({ triggerMessageId: manage })
        }

        applyCompressTransforms(state, logger, messages)

        const serialized = messageTexts(messages)
        assert.equal(messages.filter((message: WithParts) => message.parts[0]?.text?.startsWith(COMPRESS_SUMMARY_PREFIX)).length, 8)
        assert.match(serialized, /Inter-compress user 0/)
        assert.match(serialized, /Inter-compress assistant 7/)
        assert.doesNotMatch(serialized, /compress-context-map|compress manage|Compressed range/)
        assert.equal(messages.length, 24)
    })

    it("does not suppress the currently running management turn", () => {
        const sessionId = "session-cleanup-current"
        const state = createState(sessionId)
        state.managementTurns = [{ triggerMessageId: "manage-current" }]
        const messages = [
            textMessage("pre", sessionId, "Before current turn"),
            textMessage("manage-current", sessionId, "<system-reminder>/compress manage</system-reminder>"),
            textMessage("current-reason", sessionId, "Still inspecting the map", "assistant"),
            toolMessage("current-map", sessionId, "compress_map", "<compress-context-map>current</compress-context-map>"),
            ignoredUserMessage("current-notification", sessionId, "Ignored in-turn notification"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "pre",
            "manage-current",
            "current-reason",
            "current-map",
            "current-notification",
        ])
        assert.match(messageTexts(messages), /compress-context-map|Still inspecting the map/)
    })

    it("keeps unrelated mixed-content user text and removes management content", () => {
        const sessionId = "session-cleanup-mixed"
        const state = createState(sessionId)
        state.managementTurns = [
            {
                triggerMessageId: "manage-mixed",
                retainedText: "Keep this product decision verbatim.",
            },
        ]
        const messages = [
            textMessage("manage-mixed", sessionId, "<system-reminder>/compress manage</system-reminder>\n\nKeep this product decision verbatim."),
            toolMessage("mixed-map", sessionId, "compress_map", "<compress-context-map>mixed</compress-context-map>"),
            textMessage("next", sessionId, "Next turn"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), ["manage-mixed", "next"])
        assert.equal(messages[0].parts.length, 1)
        assert.equal(messages[0].parts[0].text, "Keep this product decision verbatim.")
        assert.doesNotMatch(messageTexts(messages), /system-reminder|compress-context-map/)
    })

    it("keeps provider-visible prefix bytes stable across consecutive non-management turns", () => {
        const sessionId = "session-cleanup-cache"
        const state = createState(sessionId)
        state.compressed.messageIds = new Set(["old-u", "old-a"])
        state.compressSummaries = [
            {
                anchorMessageId: "old-u",
                messageIds: ["old-u", "old-a"],
                summary: "Stable cache block.",
                topic: "Stable Cache",
            },
        ]
        state.managementTurns = [{ triggerMessageId: "manage-cache" }]
        const baseMessages = [
            textMessage("old-u", sessionId, "Old cache request"),
            textMessage("old-a", sessionId, "Old cache answer", "assistant"),
            textMessage("manage-cache", sessionId, "<system-reminder>/compress manage</system-reminder>"),
            toolMessage("cache-map", sessionId, "compress_map", "<compress-context-map>cache</compress-context-map>"),
            textMessage("tail-u-1", sessionId, "First active-tail user"),
        ] as any
        const laterMessages = [
            ...cloneMessages(baseMessages),
            textMessage("tail-a-1", sessionId, "First active-tail assistant", "assistant"),
            textMessage("tail-u-2", sessionId, "Second active-tail user"),
        ] as any

        applyCompressTransforms(state, logger, baseMessages)
        applyCompressTransforms(state, logger, laterMessages)

        assert.equal(
            serializeProviderPrefix(baseMessages, "tail-u-1"),
            serializeProviderPrefix(laterMessages, "tail-u-1"),
        )
    })

    it("reproduces suppression after persisted state reload", async () => {
        const sessionId = `session-cleanup-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)

        try {
            const state = createState(sessionId)
            state.managementTurns = [{ triggerMessageId: "manage-reload" }]
            await saveSessionState(state, logger)

            const messages = [
                textMessage("before", sessionId, "Before reload"),
                textMessage("manage-reload", sessionId, "<system-reminder>/compress manage</system-reminder>"),
                toolMessage("reload-map", sessionId, "compress_map", "<compress-context-map>reload</compress-context-map>"),
                textMessage("after", sessionId, "After reload"),
            ] as any
            const manager = new SessionStateManager()
            const handler = createChatMessageTransformHandler(
                { session: { get: async () => ({ data: {} }) } },
                manager,
                logger,
                config,
                "/tmp/reload",
            )
            const output = { messages: cloneMessages(messages) as any }

            await handler({}, output)

            assert.deepEqual(output.messages.map((message: WithParts) => message.info.id), ["before", "after"])
            assert.doesNotMatch(messageTexts(output.messages), /compress-context-map|compress manage/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("leaves subagent sessions unchanged and does not apply suppression state", async () => {
        const sessionId = "session-cleanup-subagent"
        const manager = new SessionStateManager()
        const state = manager.get(sessionId)
        state.managementTurns = [{ triggerMessageId: "manage-subagent" }]
        state.compressed.messageIds = new Set(["sub-old"])
        state.compressSummaries = [
            {
                anchorMessageId: "sub-old",
                messageIds: ["sub-old"],
                summary: "This must not be injected in subagents.",
            },
        ]
        const messages = [
            textMessage("sub-old", sessionId, "Subagent old content"),
            textMessage("manage-subagent", sessionId, "<system-reminder>/compress manage</system-reminder>"),
            toolMessage("sub-map", sessionId, "compress_map", "<compress-context-map>sub</compress-context-map>"),
            textMessage("sub-next", sessionId, "Subagent next content"),
        ] as any
        const output = { messages: cloneMessages(messages) as any }
        const handler = createChatMessageTransformHandler(
            { session: { get: async () => ({ data: { parentID: "parent-session" } }) } },
            manager,
            logger,
            config,
            "/tmp/subagent",
        )

        await handler({}, output)

        assert.deepEqual(output.messages, messages)
        assert.deepEqual(state.managementTurns, [{ triggerMessageId: "manage-subagent" }])
        assert.deepEqual([...state.compressed.messageIds], ["sub-old"])
        assert.equal(state.toolParameters.size, 0)
    })
})
