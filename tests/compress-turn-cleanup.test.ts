import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import type { Part, SessionState, TextPart, ToolPart, WithParts } from "../lib/state/types.ts"
import { isolateHostDirs, modelRequest, modelText, partText, startContextHook } from "./helpers.ts"

const root = await isolateHostDirs()
const { Logger } = await import("../lib/logger.ts")
const { applyCompressTransforms } = await import("../lib/messages/compress-transform.ts")
const { COMPRESS_SUMMARY_PREFIX } = await import("../lib/messages/utils.ts")
const { setup } = await import("../lib/plugin.ts")
const { saveSessionState } = await import("../lib/state/persistence.ts")
const { createSessionState } = await import("../lib/state/state.ts")
after(() => rm(root, { recursive: true, force: true }))

const logger = new Logger({ daily: false, context: false })

let timeCounter = 1_700_000_000_000

const textMessage = (
    id: string,
    sessionID: string,
    text: string,
    role: "user" | "assistant" = "user",
    flags: Pick<TextPart, "synthetic"> = {},
): WithParts => ({
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
    parts: [{ id: `part-${id}`, sessionID, messageID: id, type: "text", text, ...flags }],
})

const ignoredUserMessage = (id: string, sessionID: string, text: string): WithParts => ({
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
): WithParts => ({
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

function toolPart(part: Part | undefined): ToolPart {
    if (part?.type !== "tool") throw new Error("expected a tool part")
    return part
}

function toolInput(part: Part | undefined): Record<string, unknown> {
    const { input } = toolPart(part).state
    if (typeof input === "string") throw new Error("expected structured tool input")
    return input
}

const createState = (sessionId: string): SessionState => {
    const state = createSessionState()
    state.sessionId = sessionId
    state.initialized = true
    return state
}

const serializeProviderPrefix = (
    messages: WithParts[],
    firstActiveTailMessageId: string,
): string => {
    const activeTailIndex = messages.findIndex(
        (message) => message.info.id === firstActiveTailMessageId,
    )
    const prefix = activeTailIndex === -1 ? messages : messages.slice(0, activeTailIndex)
    return JSON.stringify(prefix)
}

const messageTexts = (messages: WithParts[]): string => JSON.stringify(messages)

const sessionFilePath = (sessionId: string) =>
    join(root, "data", "opencode", "storage", "plugin", "compress", `${sessionId}.json`)

// Runs the plugin's context hook on the model request built from the transcript.
const runContextHook = async (sessionId: string, transcript: WithParts[]) => {
    const context = await startContextHook(setup, root, { context: async () => transcript })
    const messages = modelRequest(transcript)
    await context(sessionId, messages)
    return messages
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
            textMessage(
                "manage-1",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            textMessage("manage-reason", sessionId, "I will inspect the map", "assistant"),
            toolMessage(
                "manage-map",
                sessionId,
                "compress_map",
                "<compress-context-map>stale</compress-context-map>",
            ),
            toolMessage(
                "manage-compress",
                sessionId,
                "compress",
                "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
            ),
            textMessage("manage-close", sessionId, "Compressed into one block", "assistant"),
            textMessage("next-user", sessionId, "Next normal request"),
        ]

        applyCompressTransforms(state, messages)

        assert.equal(messages.length, 2)
        assert.equal(partText(messages[0].parts[0])?.startsWith(COMPRESS_SUMMARY_PREFIX), true)
        assert.match(partText(messages[0].parts[0]) ?? "", /Durable block summary\./)
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
            textMessage(
                "manage-noop",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            textMessage("noop-reason", sessionId, "Nothing to compress", "assistant"),
            toolMessage(
                "noop-map",
                sessionId,
                "compress_map",
                "<compress-context-map>noop</compress-context-map>",
            ),
            textMessage("normal-after", sessionId, "Normal context after"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["normal-before", "normal-after"],
        )
        assert.doesNotMatch(
            messageTexts(messages),
            /Nothing to compress|compress-context-map|compress manage/,
        )
    })

    it("removes completed management machinery from failed or aborted turns", () => {
        const sessionId = "session-cleanup-failed"
        const state = createState(sessionId)
        state.managementTurns = [{ triggerMessageId: "manage-failed" }]
        const messages = [
            textMessage("pre", sessionId, "Before failure"),
            textMessage(
                "manage-failed",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            toolMessage(
                "failed-map",
                sessionId,
                "compress_map",
                "Tool failed while reading map",
                "call-failed-map",
                "error",
            ),
            textMessage("failed-close", sessionId, "I could not finish compression", "assistant"),
            textMessage("post", sessionId, "After failure"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["pre", "post"],
        )
        assert.doesNotMatch(messageTexts(messages), /Tool failed|could not finish|compress manage/)
    })

    it("preserves every conversation survivor across two historical management cycles", () => {
        const sessionId = "recorded-cycles"
        const state = createState(sessionId)
        state.compressed.messageIds = new Set(["old-u-a", "old-a-a", "old-u-b", "old-a-b"])
        state.compressSummaries = [
            {
                anchorMessageId: "old-u-a",
                messageIds: ["old-u-a", "old-a-a"],
                summary: "First archived work.",
            },
            {
                anchorMessageId: "old-u-b",
                messageIds: ["old-u-b", "old-a-b"],
                summary: "Second archived work.",
            },
        ]
        state.managementTurns = [{ triggerMessageId: "manage-a" }, { triggerMessageId: "manage-b" }]
        const historical = Object.freeze([
            textMessage("old-u-a", sessionId, "First request"),
            textMessage("old-a-a", sessionId, "First answer", "assistant"),
            textMessage(
                "manage-a",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            toolMessage(
                "map-a",
                sessionId,
                "compress_map",
                "<compress-context-map>first</compress-context-map>",
            ),
            toolMessage("compress-a", sessionId, "compress", "Compressed range first"),

            textMessage("between-u-a", sessionId, "Keep the first decision"),
            textMessage("between-a-a", sessionId, "First decision recorded", "assistant"),
            textMessage("old-u-b", sessionId, "Second request"),
            textMessage("old-a-b", sessionId, "Second answer", "assistant"),
            textMessage(
                "manage-b",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            toolMessage(
                "map-b",
                sessionId,
                "compress_map",
                "<compress-context-map>second</compress-context-map>",
            ),
            toolMessage("compress-b", sessionId, "compress", "Compressed range second"),

            textMessage("between-u-b", sessionId, "Keep the second decision"),
            textMessage("between-a-b", sessionId, "Second decision recorded", "assistant"),
        ])
        const messages = structuredClone([...historical])
        applyCompressTransforms(state, messages)
        assert.deepEqual(
            messages.map((message) => [message.info.role, ...message.parts.map(partText)]),
            [
                ["user", "[Compressed conversation block]\n\n[b0]\n\nFirst archived work."],
                ["user", "Keep the first decision"],
                ["assistant", "First decision recorded"],
                ["user", "[Compressed conversation block]\n\n[b1]\n\nSecond archived work."],
                ["user", "Keep the second decision"],
                ["assistant", "Second decision recorded"],
            ],
        )
    })

    it("does not suppress the currently running management turn", () => {
        const sessionId = "session-cleanup-current"
        const state = createState(sessionId)
        state.managementTurns = [{ triggerMessageId: "manage-current" }]
        const messages = [
            textMessage("pre", sessionId, "Before current turn"),
            textMessage(
                "manage-current",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            textMessage("current-reason", sessionId, "Still inspecting the map", "assistant"),
            toolMessage(
                "current-map",
                sessionId,
                "compress_map",
                "<compress-context-map>current</compress-context-map>",
            ),
            ignoredUserMessage("current-notification", sessionId, "Ignored in-turn notification"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["pre", "manage-current", "current-reason", "current-map", "current-notification"],
        )
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
            textMessage(
                "manage-mixed",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>\n\nKeep this product decision verbatim.",
            ),
            toolMessage(
                "mixed-map",
                sessionId,
                "compress_map",
                "<compress-context-map>mixed</compress-context-map>",
            ),
            textMessage("next", sessionId, "Next turn"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["manage-mixed", "next"],
        )
        assert.equal(messages[0].parts.length, 1)
        assert.equal(partText(messages[0].parts[0]), "Keep this product decision verbatim.")
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
            textMessage(
                "manage-cache",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            toolMessage(
                "cache-map",
                sessionId,
                "compress_map",
                "<compress-context-map>cache</compress-context-map>",
            ),
            textMessage("tail-u-1", sessionId, "First active-tail user"),
        ]
        const laterMessages = [
            ...cloneMessages(baseMessages),
            textMessage("tail-a-1", sessionId, "First active-tail assistant", "assistant"),
            textMessage("tail-u-2", sessionId, "Second active-tail user"),
        ]

        applyCompressTransforms(state, baseMessages)
        applyCompressTransforms(state, laterMessages)

        assert.deepEqual(
            baseMessages
                .slice(0, -1)
                .map((message) => [message.info.role, ...message.parts.map(partText)]),
            [["user", "[Compressed conversation block]\n\n[b0]\n\nStable cache block."]],
        )
        assert.equal(
            serializeProviderPrefix(baseMessages, "tail-u-1"),
            serializeProviderPrefix(laterMessages, "tail-u-1"),
        )
    })

    it("reproduces suppression after persisted state reload", async () => {
        const sessionId = "session-cleanup-reload"
        const state = createState(sessionId)
        state.managementTurns = [{ triggerMessageId: "manage-reload" }]
        await saveSessionState(state, logger)

        const messages = await runContextHook(sessionId, [
            textMessage("before", sessionId, "Before reload"),
            textMessage(
                "manage-reload",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            toolMessage(
                "reload-map",
                sessionId,
                "compress_map",
                "<compress-context-map>reload</compress-context-map>",
            ),
            textMessage("after", sessionId, "After reload"),
        ])

        assert.deepEqual(
            messages.map((message) => message.id),
            ["before", "after"],
        )
        assert.doesNotMatch(JSON.stringify(messages), /compress-context-map|compress manage/)
    })

    it("applies persisted blocks and management cleanup without rewriting state", async () => {
        const sessionId = "session-cleanup-subagent"
        const state = createState(sessionId)
        state.managementTurns = [{ triggerMessageId: "manage-subagent" }]
        state.compressed.messageIds = new Set(["sub-old"])
        state.compressSummaries = [
            {
                anchorMessageId: "sub-old",
                messageIds: ["sub-old"],
                summary: "Subagent work was compressed independently.",
            },
        ]
        await saveSessionState(state, logger)
        const persisted = await readFile(sessionFilePath(sessionId), "utf-8")

        const messages = await runContextHook(sessionId, [
            textMessage("sub-old", sessionId, "Subagent old content"),
            textMessage(
                "manage-subagent",
                sessionId,
                "<system-reminder>/compress manage</system-reminder>",
            ),
            toolMessage(
                "sub-map",
                sessionId,
                "compress_map",
                "<compress-context-map>sub</compress-context-map>",
            ),
            textMessage("sub-next", sessionId, "Subagent next content"),
        ])

        assert.equal(messages.length, 2)
        assert.notEqual(messages[0].id, "sub-old")
        assert.match(modelText(messages[0]), /Subagent work was compressed independently/)
        assert.equal(messages[1].id, "sub-next")
        assert.doesNotMatch(
            JSON.stringify(messages),
            /Subagent old content|compress manage|compress-context-map/,
        )
        assert.equal(await readFile(sessionFilePath(sessionId), "utf-8"), persisted)
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
            textMessage(
                "slice3-reason",
                sessionId,
                "I will inspect the map and fold completed work.",
                "assistant",
            ),
            toolMessage(
                "slice3-map",
                sessionId,
                "compress_map",
                "<compress-context-map>stale</compress-context-map>",
            ),
            toolMessage(
                "slice3-compress",
                sessionId,
                "compress",
                "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
            ),
            textMessage("slice3-close", sessionId, "Compression complete.", "assistant"),
            statusNotificationMessage("slice3-notification", sessionId, "12.0K tokens"),
            textMessage("slice3-next", sessionId, "Continue with the next dashboard task"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["slice3-real-user", "slice3-real-answer", "slice3-next"],
        )
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
            textMessage(
                "legacy-mixed-manage",
                sessionId,
                [
                    REALISTIC_MANAGE_PROMPT_TEXT,
                    "",
                    "<user-message>",
                    "The launch window is June.",
                    "</user-message>",
                ].join("\n"),
            ),
            toolMessage(
                "legacy-mixed-map",
                sessionId,
                "compress_map",
                "<compress-context-map>stale</compress-context-map>",
            ),
            textMessage("legacy-mixed-next", sessionId, "Continue with the launch checklist"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["legacy-mixed-manage", "legacy-mixed-next"],
        )
        assert.equal(messages[0].parts.length, 1)
        assert.equal(partText(messages[0].parts[0]), "The launch window is June.")
        const serialized = messageTexts(messages)
        assert.doesNotMatch(
            serialized,
            /CONTEXT MANAGEMENT REQUESTED|compress-context-map|<user-message>/,
        )
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
            textMessage(
                "legacy-incomplete-manage",
                sessionId,
                [
                    REALISTIC_MANAGE_PROMPT_TEXT,
                    "",
                    "<user-message>",
                    "The launch window is June.",
                    "</user-message>",
                ].join("\n"),
            ),
            toolMessage(
                "legacy-incomplete-map",
                sessionId,
                "compress_map",
                "<compress-context-map>stale</compress-context-map>",
            ),
            textMessage("legacy-incomplete-next", sessionId, "Continue with the launch checklist"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["legacy-incomplete-manage", "legacy-incomplete-next"],
        )
        assert.equal(messages[0].parts.length, 1)
        assert.equal(partText(messages[0].parts[0]), "The launch window is June.")
        const serialized = messageTexts(messages)
        assert.doesNotMatch(
            serialized,
            /CONTEXT MANAGEMENT REQUESTED|compress-context-map|<user-message>/,
        )
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
            toolMessage(
                "wips-map",
                sessionId,
                "compress_map",
                "<compress-context-map>stale</compress-context-map>",
            ),
            toolMessage(
                "wips-compress",
                sessionId,
                "compress",
                "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
            ),
            statusNotificationMessage("wips-notification", sessionId, "4.0K tokens"),
            textMessage("wips-next", sessionId, "Continue phase 1A work"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["wips-real-user", "wips-real-answer", "wips-next"],
        )
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
            toolMessage(
                "inflight-map",
                sessionId,
                "compress_map",
                "<compress-context-map>current</compress-context-map>",
            ),
            toolMessage(
                "inflight-compress",
                sessionId,
                "compress",
                "Compressed range\n\n<compress-context-map>updated</compress-context-map>",
            ),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["inflight-pre", "inflight-manage", "inflight-map", "inflight-compress"],
        )
        assert.match(messageTexts(messages), /compress-context-map/)
    })

    it("keeps ordinary conversation that merely mentions compress with no plugin signatures", () => {
        const sessionId = "session-cleanup-negative"
        const state = createState(sessionId)
        const messages = [
            textMessage(
                "neg-user-1",
                sessionId,
                "Can you compress these launch photos before we ship them?",
            ),
            textMessage(
                "neg-answer-1",
                sessionId,
                "Sure, I'll compress the images and report file sizes.",
                "assistant",
            ),
            textMessage(
                "neg-user-2",
                sessionId,
                "Compress again please, but this time keep the metadata.",
            ),
            textMessage(
                "neg-answer-2",
                sessionId,
                "Compressing with metadata retained now.",
                "assistant",
            ),
            textMessage("neg-user-3", sessionId, "Compress again."),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["neg-user-1", "neg-answer-1", "neg-user-2", "neg-answer-2", "neg-user-3"],
        )
    })

    it("preserves a genuine final reply after normal-turn compression", () => {
        const sessionId = "session-cleanup-normal-compression"
        const state = createState(sessionId)
        state.compressed.messageIds = new Set(["normal-old-user", "normal-old-assistant"])
        state.compressSummaries = [
            {
                anchorMessageId: "normal-old-user",
                messageIds: ["normal-old-user", "normal-old-assistant"],
                summary: "Earlier work was completed.",
                topic: "Earlier Work",
            },
        ]
        const messages = [
            textMessage("normal-old-user", sessionId, "Earlier request"),
            textMessage("normal-old-assistant", sessionId, "Earlier result", "assistant"),
            textMessage(
                "normal-current-user",
                sessionId,
                "Continue and compress old context if useful",
            ),
            toolMessage(
                "normal-map",
                sessionId,
                "compress_map",
                "<compress-context-map>current</compress-context-map>",
            ),
            toolMessage("normal-compress", sessionId, "compress", "Compression complete"),
            statusNotificationMessage("normal-notification", sessionId, "4.0K tokens"),
            textMessage(
                "normal-final",
                sessionId,
                "The requested implementation is complete.",
                "assistant",
            ),
            textMessage("normal-next-user", sessionId, "Now add the follow-up"),
        ]

        applyCompressTransforms(state, messages)

        assert.equal(
            messages.some((message: WithParts) => message.info.id === "normal-final"),
            true,
        )
        assert.equal(
            messages.some((message: WithParts) => message.info.id === "normal-next-user"),
            true,
        )
        assert.equal(
            messages.some((message: WithParts) => message.info.id === "normal-notification"),
            false,
        )
        assert.match(messageTexts(messages), /The requested implementation is complete\./)
    })

    it("repairs two historical cycles with missing and stale bookkeeping", () => {
        const sessionId = "legacy-cycles"
        const state = createState(sessionId)
        state.compressed.messageIds = new Set([
            "legacy-old-u-a",
            "legacy-old-a-a",
            "legacy-old-u-b",
            "legacy-old-a-b",
        ])
        state.compressSummaries = [
            {
                anchorMessageId: "legacy-old-u-a",
                messageIds: ["legacy-old-u-a", "legacy-old-a-a"],
                summary: "First archived work.",
            },
            {
                anchorMessageId: "legacy-old-u-b",
                messageIds: ["legacy-old-u-b", "legacy-old-a-b"],
                summary: "Second archived work.",
            },
        ]
        state.managementTurns = [{ triggerMessageId: "legacy-notice-a" }]
        const historical = Object.freeze([
            textMessage("legacy-old-u-a", sessionId, "First request"),
            textMessage("legacy-old-a-a", sessionId, "First answer", "assistant"),
            textMessage("manage-a", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            toolMessage(
                "map-a",
                sessionId,
                "compress_map",
                "<compress-context-map>first</compress-context-map>",
            ),
            toolMessage("compress-a", sessionId, "compress", "Compressed range first"),
            statusNotificationMessage("legacy-notice-a", sessionId, "1.0K tokens"),
            textMessage("between-u-a", sessionId, "Keep the first decision"),
            textMessage("between-a-a", sessionId, "First decision recorded", "assistant"),
            textMessage("legacy-old-u-b", sessionId, "Second request"),
            textMessage("legacy-old-a-b", sessionId, "Second answer", "assistant"),
            textMessage("manage-b", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            toolMessage(
                "map-b",
                sessionId,
                "compress_map",
                "<compress-context-map>second</compress-context-map>",
            ),
            toolMessage("compress-b", sessionId, "compress", "Compressed range second"),
            statusNotificationMessage("legacy-notice-b", sessionId, "2.0K tokens"),
            textMessage("between-u-b", sessionId, "Keep the second decision"),
            textMessage("between-a-b", sessionId, "Second decision recorded", "assistant"),
        ])
        const messages = structuredClone([...historical])
        applyCompressTransforms(state, messages)
        assert.deepEqual(
            messages.map((message) => [message.info.role, ...message.parts.map(partText)]),
            [
                ["user", "[Compressed conversation block]\n\n[b0]\n\nFirst archived work."],
                ["user", "Keep the first decision"],
                ["assistant", "First decision recorded"],
                ["user", "[Compressed conversation block]\n\n[b1]\n\nSecond archived work."],
                ["user", "Keep the second decision"],
                ["assistant", "Second decision recorded"],
            ],
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
                completedMessageId: "compress-msg-1",
            },
        ]

        const messages = [
            textMessage("work-user", sessionId, "Old request"),
            textMessage("work-assistant", sessionId, "Old answer", "assistant"),
            textMessage(
                "manage-1",
                sessionId,
                REALISTIC_MANAGE_PROMPT_TEXT +
                    "\n\n<compress-context-map>stale</compress-context-map>",
            ),
            toolMessage(
                "compress-msg-1",
                sessionId,
                "compress",
                'Compression complete. Stored [b1] "New Work".',
                "call-compress-1",
            ),
            statusNotificationMessage("notif-1", sessionId, "5.0K tokens"),
        ]

        applyCompressTransforms(state, messages)

        assert.equal(messages.length, 2)
        assert.equal(partText(messages[0].parts[0])?.startsWith(COMPRESS_SUMMARY_PREFIX), true)
        assert.equal(messages[1].info.id, "compress-msg-1")

        const compressPart = toolPart(messages[1].parts[0])
        assert.equal(compressPart.callID, "call-compress-1")
        assert.equal(toolInput(compressPart).summary, "summary")
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
                completedMessageId: "compress-msg-2",
            },
        ]

        const messages = [
            textMessage("pre", sessionId, "Before this turn"),
            textMessage(
                "manage-2",
                sessionId,
                REALISTIC_MANAGE_PROMPT_TEXT +
                    "\n\n<compress-context-map>stale</compress-context-map>",
            ),
            toolMessage(
                "compress-msg-2",
                sessionId,
                "compress",
                'Compression complete. Stored [b0] "Prior Work".',
                "call-compress-2",
            ),
            textMessage(
                "final-reply-2",
                sessionId,
                "All set! Let me know what's next.",
                "assistant",
            ),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["pre", "compress-msg-2", "final-reply-2"],
        )
        assert.equal(toolInput(messages[1].parts[0]).summary, "summary")
        assert.match(messageTexts(messages), /All set! Let me know what's next\./)
        assert.doesNotMatch(
            messageTexts(messages),
            /CONTEXT MANAGEMENT REQUESTED|compress-context-map/,
        )
    })

    it("cleans up a historical bounded turn and the just-completed unbounded turn independently in the same pass", () => {
        const sessionId = "session-atomic-mixed-turns"
        const state = createState(sessionId)
        state.managementTurns = [
            { triggerMessageId: "old-manage" },
            {
                triggerMessageId: "new-manage",
                completedAt: new Date().toISOString(),
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
                REALISTIC_MANAGE_PROMPT_TEXT +
                    "\n\n<compress-context-map>fresh</compress-context-map>",
            ),
            toolMessage(
                "new-compress-msg",
                sessionId,
                "compress",
                'Compression complete. Stored [b1] "New Work".',
                "call-new-compress",
            ),
            statusNotificationMessage("new-notif", sessionId, "2.0K tokens"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            [
                "old-work-user",
                "old-work-assistant",
                "between-user",
                "between-assistant",
                "new-compress-msg",
            ],
        )
        assert.equal(toolInput(messages[4].parts[0]).summary, "summary")
        const serialized = messageTexts(messages)
        assert.doesNotMatch(
            serialized,
            /CONTEXT MANAGEMENT REQUESTED|compress-context-map|▣ Context Compress|Compressed range old/,
        )
        assert.match(serialized, /Normal follow-up between compressions/)
    })
})

describe("prospective Version 2 cleanup", () => {
    it("preserves every non-plugin message while rotating to one newest machinery set", () => {
        const sessionId = "session-cleanup-v2-rotation"
        const state = createState(sessionId)
        state.managementTurns = [
            {
                triggerMessageId: "manage-v2-a",
                cleanupVersion: 2,
                completedAt: "2026-08-27T00:00:00.000Z",
                completedMessageId: "compress-v2-a",
            },
            {
                triggerMessageId: "manage-v2-b",
                cleanupVersion: 2,
                completedAt: "2026-08-27T01:00:00.000Z",
                completedMessageId: "compress-v2-b",
            },
        ]
        const firstCompletion = toolMessage("compress-v2-a", sessionId, "compress", "first receipt")
        firstCompletion.parts.unshift({
            id: "before-first-tool",
            sessionID: sessionId,
            messageID: firstCompletion.info.id,
            type: "text",
            text: "assistant text before first compress",
        })
        firstCompletion.parts.push({
            id: "after-first-tool",
            sessionID: sessionId,
            messageID: firstCompletion.info.id,
            type: "text",
            text: "assistant text after first compress",
        })
        const secondCompletion = toolMessage(
            "compress-v2-b",
            sessionId,
            "compress",
            "second receipt",
        )
        const synthetic = textMessage(
            "synthetic-v2-b",
            sessionId,
            "synthetic continuation",
            "user",
            {
                synthetic: true,
            },
        )
        synthetic.info.sourceType = "synthetic"
        const system = textMessage("system-v2-b", sessionId, "system update")
        system.info.role = "system"

        const messages = [
            textMessage("pre-v2", sessionId, "ordinary history"),
            textMessage("manage-v2-a", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            textMessage(
                "pre-compress-v2-a",
                sessionId,
                "agent-authored compression reasoning",
                "assistant",
            ),
            firstCompletion,
            statusNotificationMessage("notification-v2-a", sessionId, "first stats"),
            textMessage("work-v2-a", sessionId, "work after first compression", "assistant"),
            textMessage("user-v2-a", sessionId, "first user boundary"),
            textMessage("reply-v2-a", sessionId, "reply after first boundary", "assistant"),
            textMessage("manage-v2-b", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            secondCompletion,
            statusNotificationMessage("notification-v2-b", sessionId, "second stats"),
            synthetic,
            system,
            toolMessage("work-tool-v2-b", sessionId, "read", "tool evidence"),
            textMessage("user-v2-b", sessionId, "second user boundary"),
        ]

        applyCompressTransforms(state, messages)

        const ids = messages.map((message: WithParts) => message.info.id)
        assert.deepEqual(ids, [
            "pre-v2",
            "pre-compress-v2-a",
            "compress-v2-a",
            "work-v2-a",
            "user-v2-a",
            "reply-v2-a",
            "compress-v2-b",
            "synthetic-v2-b",
            "system-v2-b",
            "work-tool-v2-b",
            "user-v2-b",
        ])
        assert.deepEqual(
            messages.map((message) =>
                message.parts.map((part) =>
                    part.type === "text"
                        ? part.text
                        : part.type === "tool"
                          ? [part.tool, part.state.output]
                          : part.type,
                ),
            ),
            [
                ["ordinary history"],
                ["agent-authored compression reasoning"],
                ["assistant text before first compress", "assistant text after first compress"],
                ["work after first compression"],
                ["first user boundary"],
                ["reply after first boundary"],
                [["compress", "second receipt"]],
                ["synthetic continuation"],
                ["system update"],
                [["read", "tool evidence"]],
                ["second user boundary"],
            ],
        )
    })

    it("lets compressed state override retained Version 2 parts", () => {
        const sessionId = "session-cleanup-v2-compressed-wins"
        const state = createState(sessionId)
        state.managementTurns = [
            {
                triggerMessageId: "manage-old-v2",
                cleanupVersion: 2,
                completedAt: "2026-08-27T00:00:00.000Z",
                completedMessageId: "compress-old-v2",
            },
            {
                triggerMessageId: "manage-new-v2",
                cleanupVersion: 2,
                completedAt: "2026-08-27T01:00:00.000Z",
                completedMessageId: "compress-new-v2",
            },
        ]
        state.compressed.messageIds = new Set(["compress-old-v2"])
        state.compressSummaries = [
            {
                anchorMessageId: "compress-old-v2",
                messageIds: ["compress-old-v2"],
                summary: "Older Version 2 work is represented here.",
                topic: "Older V2",
            },
        ]
        const older = toolMessage("compress-old-v2", sessionId, "compress", "old receipt")
        older.parts.push({
            id: "old-retained-text",
            sessionID: sessionId,
            messageID: older.info.id,
            type: "text",
            text: "raw text that must stay compressed",
        })
        const messages = [
            textMessage("manage-old-v2", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            older,
            textMessage("user-old-v2", sessionId, "old boundary"),
            textMessage("manage-new-v2", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            toolMessage("compress-new-v2", sessionId, "compress", "new receipt"),
        ]

        applyCompressTransforms(state, messages)

        assert.equal(
            messages.some(
                (message: WithParts) =>
                    message.info.id === "compress-old-v2" &&
                    message.parts.some(
                        (part) => partText(part) === "raw text that must stay compressed",
                    ),
            ),
            false,
        )
        assert.match(messageTexts(messages), /Older Version 2 work is represented here/)
        assert.equal(
            messages
                .flatMap((message: WithParts) => message.parts)
                .filter((part) => part.type === "tool" && part.tool === "compress").length,
            1,
        )
    })

    it("keeps the history before a later in-flight compression byte-stable", () => {
        const sessionId = "session-cleanup-v2-active"
        const completed = {
            triggerMessageId: "manage-completed-v2",
            cleanupVersion: 2 as const,
            completedAt: "2026-08-27T00:00:00.000Z",
            completedMessageId: "compress-completed-v2",
        }
        const history = [
            textMessage("manage-completed-v2", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            toolMessage("compress-completed-v2", sessionId, "compress", "previous receipt"),
            textMessage("user-between-v2", sessionId, "continue"),
        ]
        const before = createState(sessionId)
        before.managementTurns = [completed]
        const beforeMessages = structuredClone(history)
        applyCompressTransforms(before, beforeMessages)

        const state = createState(sessionId)
        state.managementTurns = [
            completed,
            { triggerMessageId: "manage-active-v2", cleanupVersion: 2 },
        ]
        const messages = [
            ...history,
            textMessage("manage-active-v2", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            textMessage(
                "active-work-v2",
                sessionId,
                "work performed during compression",
                "assistant",
            ),
        ]
        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["compress-completed-v2", "user-between-v2", "manage-active-v2", "active-work-v2"],
        )
        assert.deepEqual(messages.slice(0, beforeMessages.length), beforeMessages)
        assert.match(messageTexts(messages), /work performed during compression/)
    })

    it("removes a bounded failed Version 2 tool attempt without touching sibling work", () => {
        const sessionId = "session-cleanup-v2-failed"
        const state = createState(sessionId)
        state.managementTurns = [
            {
                triggerMessageId: "manage-failed-v2",
                cleanupVersion: 2,
            },
        ]
        const failed = toolMessage("failed-compress-v2", sessionId, "compress", "unused")
        toolPart(failed.parts[0]).state = { status: "error", input: {}, error: "nothing eligible" }
        failed.parts.push({
            id: "failed-sibling-work",
            sessionID: sessionId,
            messageID: failed.info.id,
            type: "text",
            text: "useful work beside the failed compression",
        })
        const messages = [
            textMessage("manage-failed-v2", sessionId, REALISTIC_MANAGE_PROMPT_TEXT),
            failed,
            textMessage("user-after-failed-v2", sessionId, "continue after failure"),
        ]

        applyCompressTransforms(state, messages)

        assert.deepEqual(
            messages.map((message: WithParts) => message.info.id),
            ["failed-compress-v2", "user-after-failed-v2"],
        )
        assert.equal(
            messages[0].parts.some((part) => part.type === "tool" && part.tool === "compress"),
            false,
        )
        assert.match(
            messageTexts(messages),
            /useful work beside the failed compression|continue after failure/,
        )
        assert.doesNotMatch(messageTexts(messages), /CONTEXT MANAGEMENT REQUESTED|nothing eligible/)
    })
})
