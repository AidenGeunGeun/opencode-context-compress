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

const REALISTIC_MANAGE_PROMPT_TEXT =
    "<system-reminder>\nCONTEXT MANAGEMENT REQUESTED\nThe user explicitly ran `/compress manage`.\n</system-reminder>"

const statusNotificationMessage = (id: string, sessionID: string, tokensSaved: string) =>
    ignoredUserMessage(id, sessionID, `▣ Context Compress | ~${tokensSaved} saved total`)

describe("legacy residue repair by content signature", () => {
    it("repairs Slice-3-style residue when the persisted trigger points at a later status notification", () => {
        const sessionId = "session-cleanup-slice3"
        const state = createState(sessionId)
        // Reproduces the observed bug: the persisted trigger is anchored at the LATER
        // ignored notification instead of the actual manage prompt that started the turn.
        state.managementTurns = [{ triggerMessageId: "slice3-notification" }]

        const messages = [
            textMessage("slice3-real-user", sessionId, "Finish the dashboard shell handoff"),
            textMessage("slice3-real-answer", sessionId, "Handoff notes written.", "assistant"),
            textMessage("slice3-manage", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            textMessage("slice3-reason", sessionId, "I will inspect the map and fold completed work.", "assistant"),
            toolMessage("slice3-map", sessionId, "compress_map", "<compress-context-map>stale</compress-context-map>"),
            toolMessage(
                "slice3-compress",
                sessionId,
                "compress",
                "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
            ),
            textMessage("slice3-close", sessionId, "Compression complete.", "assistant"),
            statusNotificationMessage("slice3-notification", sessionId, "12.0K tokens"),
            textMessage("slice3-next", sessionId, "Continue with the next dashboard task"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "slice3-real-user",
            "slice3-real-answer",
            "slice3-next",
        ])
        const serialized = messageTexts(messages)
        assert.doesNotMatch(serialized, /CONTEXT MANAGEMENT REQUESTED/)
        assert.doesNotMatch(serialized, /compress-context-map/)
        assert.doesNotMatch(serialized, /▣ Context Compress/)
        assert.doesNotMatch(serialized, /I will inspect the map/)
        assert.doesNotMatch(serialized, /Compression complete/)
    })

    it("retains real mixed-content user text from a legacy manage prompt with no managementTurns state", () => {
        const sessionId = "session-cleanup-legacy-mixed"
        const state = createState(sessionId)
        // No managementTurns recorded at all - this legacy history must be repaired by
        // content signature alone, and the embedded real instruction must survive.
        state.managementTurns = []

        const messages = [
            textMessage("legacy-mixed-manage", sessionId, [
                REALISTIC_MANAGE_PROMPT_TEXT,
                "",
                "<user-message>",
                "The launch window is June.",
                "</user-message>",
            ].join("\n")),
            toolMessage("legacy-mixed-map", sessionId, "compress_map", "<compress-context-map>stale</compress-context-map>"),
            textMessage("legacy-mixed-next", sessionId, "Continue with the launch checklist"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "legacy-mixed-manage",
            "legacy-mixed-next",
        ])
        assert.equal(messages[0].parts.length, 1)
        assert.equal(messages[0].parts[0].text, "The launch window is June.")
        const serialized = messageTexts(messages)
        assert.doesNotMatch(serialized, /CONTEXT MANAGEMENT REQUESTED|compress-context-map|<user-message>/)
        assert.match(serialized, /The launch window is June\./)
    })

    it("retains real mixed-content user text even when managementTurns has an incomplete entry for it", () => {
        const sessionId = "session-cleanup-legacy-mixed-incomplete"
        const state = createState(sessionId)
        // Incomplete legacy bookkeeping: the trigger IS recorded (unlike the fully-missing
        // case above), but without the `retainedText` field, as would happen if an older
        // plugin version persisted the turn before this repair existed. The state-based plan
        // alone would suppress the whole message; legacy-signature retention must still win.
        state.managementTurns = [{ triggerMessageId: "legacy-incomplete-manage" }]

        const messages = [
            textMessage("legacy-incomplete-manage", sessionId, [
                REALISTIC_MANAGE_PROMPT_TEXT,
                "",
                "<user-message>",
                "The launch window is June.",
                "</user-message>",
            ].join("\n")),
            toolMessage(
                "legacy-incomplete-map",
                sessionId,
                "compress_map",
                "<compress-context-map>stale</compress-context-map>",
            ),
            textMessage("legacy-incomplete-next", sessionId, "Continue with the launch checklist"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "legacy-incomplete-manage",
            "legacy-incomplete-next",
        ])
        assert.equal(messages[0].parts.length, 1)
        assert.equal(messages[0].parts[0].text, "The launch window is June.")
        const serialized = messageTexts(messages)
        assert.doesNotMatch(serialized, /CONTEXT MANAGEMENT REQUESTED|compress-context-map|<user-message>/)
        assert.match(serialized, /The launch window is June\./)
    })

    it("repairs WIPS-style orphaned compress_map/compress residue without relying on managementTurns", () => {
        const sessionId = "session-cleanup-wips"
        const state = createState(sessionId)
        // Legacy/incomplete persisted state: nothing recorded in managementTurns at all.
        state.managementTurns = []

        const messages = [
            textMessage("wips-real-user", sessionId, "Split orchestrator into phase 1A slices"),
            textMessage("wips-real-answer", sessionId, "Slice plan drafted.", "assistant"),
            textMessage("wips-manage", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            toolMessage("wips-map", sessionId, "compress_map", "<compress-context-map>stale</compress-context-map>"),
            toolMessage(
                "wips-compress",
                sessionId,
                "compress",
                "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
            ),
            statusNotificationMessage("wips-notification", sessionId, "4.0K tokens"),
            textMessage("wips-next", sessionId, "Continue phase 1A work"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "wips-real-user",
            "wips-real-answer",
            "wips-next",
        ])
        const serialized = messageTexts(messages)
        assert.doesNotMatch(serialized, /compress-context-map/)
        assert.doesNotMatch(serialized, /▣ Context Compress/)
        assert.doesNotMatch(serialized, /CONTEXT MANAGEMENT REQUESTED/)
    })

    it("keeps the compress tool's refreshed map visible for the same in-flight turn with no next user message yet", () => {
        const sessionId = "session-cleanup-inflight-compress"
        const state = createState(sessionId)
        state.managementTurns = [{ triggerMessageId: "inflight-manage" }]
        const messages = [
            textMessage("inflight-pre", sessionId, "Before this turn"),
            textMessage("inflight-manage", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            toolMessage("inflight-map", sessionId, "compress_map", "<compress-context-map>current</compress-context-map>"),
            toolMessage(
                "inflight-compress",
                sessionId,
                "compress",
                "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
            ),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "inflight-pre",
            "inflight-manage",
            "inflight-map",
            "inflight-compress",
        ])
        assert.match(messageTexts(messages), /compress-context-map/)
    })

    it("keeps ordinary conversation that merely mentions compress with no plugin signatures", () => {
        const sessionId = "session-cleanup-negative"
        const state = createState(sessionId)
        const messages = [
            textMessage("neg-user-1", sessionId, "Can you compress these launch photos before we ship them?"),
            textMessage("neg-answer-1", sessionId, "Sure, I'll compress the images and report file sizes.", "assistant"),
            textMessage("neg-user-2", sessionId, "Compress again please, but this time keep the metadata."),
            textMessage("neg-answer-2", sessionId, "Compressing with metadata retained now.", "assistant"),
            textMessage("neg-user-3", sessionId, "Compress again."),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "neg-user-1",
            "neg-answer-1",
            "neg-user-2",
            "neg-answer-2",
            "neg-user-3",
        ])
    })

    it("prevents residue drift across repeated cycles even when managementTurns bookkeeping is wrong or missing", () => {
        const sessionId = "session-cleanup-many-legacy"
        const state = createState(sessionId)
        const messages: any[] = []

        for (let i = 0; i < 5; i++) {
            const workUser = `legacy-work-u-${i}`
            const workAssistant = `legacy-work-a-${i}`
            const manage = `legacy-manage-${i}`
            messages.push(textMessage(workUser, sessionId, `Completed phase ${i} request`))
            messages.push(textMessage(workAssistant, sessionId, `Completed phase ${i} answer`, "assistant"))
            messages.push(textMessage(manage, sessionId, REALISTIC_MANAGE_PROMPT_TEXT))
            messages.push(
                toolMessage(`legacy-map-${i}`, sessionId, "compress_map", `<compress-context-map>${i}</compress-context-map>`),
            )
            messages.push(toolMessage(`legacy-compress-${i}`, sessionId, "compress", `Compressed range ${i}`))
            messages.push(statusNotificationMessage(`legacy-notification-${i}`, sessionId, `${i}.0K tokens`))
            messages.push(textMessage(`legacy-between-u-${i}`, sessionId, `Inter-compress user ${i}`))
            messages.push(textMessage(`legacy-between-a-${i}`, sessionId, `Inter-compress assistant ${i}`, "assistant"))

            state.compressed.messageIds.add(workUser)
            state.compressed.messageIds.add(workAssistant)
            state.compressSummaries.push({
                anchorMessageId: workUser,
                messageIds: [workUser, workAssistant],
                summary: `Block summary ${i}`,
                topic: `Block ${i}`,
            })

            // Deliberately leave the bookkeeping broken: only every other cycle gets a
            // managementTurns entry, and that entry points at the later notification
            // rather than the real manage prompt - mirroring both observed patterns at once.
            if (i % 2 === 0) {
                state.managementTurns.push({ triggerMessageId: `legacy-notification-${i}` })
            }
        }

        applyCompressTransforms(state, logger, messages)

        const serialized = messageTexts(messages)
        assert.equal(
            messages.filter((message: WithParts) => message.parts[0]?.text?.startsWith(COMPRESS_SUMMARY_PREFIX)).length,
            5,
        )
        assert.match(serialized, /Inter-compress user 0/)
        assert.match(serialized, /Inter-compress assistant 4/)
        assert.doesNotMatch(
            serialized,
            /compress-context-map|CONTEXT MANAGEMENT REQUESTED|▣ Context Compress|Compressed range/,
        )
    })
})

describe("atomic compress completion cleanup", () => {
    it("hides the manage prompt, injected map, and notification immediately once compress completes, with no next visible user message yet", () => {
        const sessionId = "session-atomic-completion"
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
        state.managementTurns = [
            {
                triggerMessageId: "manage-1",
                completedAt: new Date().toISOString(),
                completedCallId: "call-compress-1",
                completedMessageId: "compress-msg-1",
            },
        ]

        const messages = [
            textMessage("work-user", sessionId, "Old request"),
            textMessage("work-assistant", sessionId, "Old answer", "assistant"),
            textMessage(
                "manage-1",
                sessionId,
                REALISTIC_MANAGE_PROMPT_TEXT + "\n\n<compress-context-map>stale</compress-context-map>",
            ),
            toolMessage(
                "compress-msg-1",
                sessionId,
                "compress",
                'Compression complete. Stored [b1] "New Work".',
                "call-compress-1",
            ),
            statusNotificationMessage("notif-1", sessionId, "5.0K tokens"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.equal(messages.length, 2)
        assert.equal(messages[0].parts[0].text.startsWith(COMPRESS_SUMMARY_PREFIX), true)
        assert.equal(messages[1].info.id, "compress-msg-1")

        const compressPart = messages[1].parts[0]
        assert.equal(compressPart.callID, "call-compress-1")
        assert.equal(compressPart.state.input.summary, "[summary stored in compressed block]")
        assert.equal(compressPart.state.output, 'Compression complete. Stored [b1] "New Work".')

        const serialized = messageTexts(messages)
        assert.doesNotMatch(serialized, /CONTEXT MANAGEMENT REQUESTED/)
        assert.doesNotMatch(serialized, /compress-context-map/)
        assert.doesNotMatch(serialized, /▣ Context Compress/)
    })

    it("keeps the agent's genuine final reply after the completed compress call, without sweeping it as chatter", () => {
        const sessionId = "session-atomic-completion-reply"
        const state = createState(sessionId)
        state.managementTurns = [
            {
                triggerMessageId: "manage-2",
                completedAt: new Date().toISOString(),
                completedCallId: "call-compress-2",
                completedMessageId: "compress-msg-2",
            },
        ]

        const messages = [
            textMessage("pre", sessionId, "Before this turn"),
            textMessage(
                "manage-2",
                sessionId,
                REALISTIC_MANAGE_PROMPT_TEXT + "\n\n<compress-context-map>stale</compress-context-map>",
            ),
            toolMessage(
                "compress-msg-2",
                sessionId,
                "compress",
                'Compression complete. Stored [b0] "Prior Work".',
                "call-compress-2",
            ),
            textMessage("final-reply-2", sessionId, "All set! Let me know what's next.", "assistant"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "pre",
            "compress-msg-2",
            "final-reply-2",
        ])
        assert.equal(messages[1].parts[0].state.input.summary, "[summary stored in compressed block]")
        assert.match(messageTexts(messages), /All set! Let me know what's next\./)
        assert.doesNotMatch(messageTexts(messages), /CONTEXT MANAGEMENT REQUESTED|compress-context-map/)
    })

    it("cleans up a historical bounded turn and the just-completed unbounded turn independently in the same pass", () => {
        const sessionId = "session-atomic-mixed-turns"
        const state = createState(sessionId)
        state.managementTurns = [
            { triggerMessageId: "old-manage" },
            {
                triggerMessageId: "new-manage",
                completedAt: new Date().toISOString(),
                completedCallId: "call-new-compress",
                completedMessageId: "new-compress-msg",
            },
        ]

        const messages = [
            textMessage("old-work-user", sessionId, "Old phase request"),
            textMessage("old-work-assistant", sessionId, "Old phase answer", "assistant"),
            textMessage("old-manage", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            toolMessage("old-compress-msg", sessionId, "compress", "Compressed range old"),
            statusNotificationMessage("old-notif", sessionId, "1.0K tokens"),
            textMessage("between-user", sessionId, "Normal follow-up between compressions"),
            textMessage("between-assistant", sessionId, "Normal follow-up answer", "assistant"),
            textMessage(
                "new-manage",
                sessionId,
                REALISTIC_MANAGE_PROMPT_TEXT + "\n\n<compress-context-map>fresh</compress-context-map>",
            ),
            toolMessage(
                "new-compress-msg",
                sessionId,
                "compress",
                'Compression complete. Stored [b1] "New Work".',
                "call-new-compress",
            ),
            statusNotificationMessage("new-notif", sessionId, "2.0K tokens"),
        ] as any

        applyCompressTransforms(state, logger, messages)

        assert.deepEqual(messages.map((message: WithParts) => message.info.id), [
            "old-work-user",
            "old-work-assistant",
            "between-user",
            "between-assistant",
            "new-compress-msg",
        ])
        assert.equal(messages[4].parts[0].state.input.summary, "[summary stored in compressed block]")
        const serialized = messageTexts(messages)
        assert.doesNotMatch(serialized, /CONTEXT MANAGEMENT REQUESTED|compress-context-map|▣ Context Compress|Compressed range old/)
        assert.match(serialized, /Normal follow-up between compressions/)
    })
})
