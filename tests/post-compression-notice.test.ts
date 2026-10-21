import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { createChatMessageTransformHandler } from "./transform-harness.ts"
import { Logger } from "../lib/logger.ts"
import { renderPostCompressionNotice } from "../lib/prompts/index.ts"
import { isIgnoredUserMessage } from "../lib/messages/utils.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import type {
    MarkerPart,
    Message,
    Part,
    TextPart,
    ToolPart,
    WithParts,
} from "../lib/state/types.ts"

const logger = new Logger({ daily: false, context: false })

let timeCounter = 1_800_000_000_000

const userMessage = (
    id: string,
    sessionID: string,
    text: string,
    flags: Pick<TextPart, "ignored" | "synthetic"> = {},
): WithParts => ({
    info: {
        id,
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        time: { created: timeCounter++ },
    },
    parts: [{ id: `part-${id}`, sessionID, messageID: id, type: "text", text, ...flags }],
})

const ignoredUserMessage = (id: string, sessionID: string, text: string): WithParts =>
    userMessage(id, sessionID, text, { ignored: true })

const syntheticContinuationMessage = (id: string, sessionID: string): WithParts =>
    userMessage(id, sessionID, "Continue the current task from the latest durable state.", {
        synthetic: true,
    })

const assistantMessage = (
    id: string,
    sessionID: string,
    parts: Part[],
    info: Partial<Message> = {},
): WithParts => ({
    info: {
        id,
        role: "assistant",
        sessionID,
        agent: "build",
        time: { created: timeCounter++, completed: timeCounter++ },
        ...info,
    },
    parts: parts.map((part, index) => ({
        id: `part-${id}-${index}`,
        sessionID,
        messageID: id,
        ...part,
    })),
})

const compressPart = (): ToolPart => ({
    type: "tool",
    tool: "compress",
    callID: "call-compress",
    state: {
        status: "completed",
        input: { summary: "summary", topic: "topic" },
        output: "Compression complete.",
    },
})

const textPart = (text: string): TextPart => ({ type: "text", text })

const stepFinishPart = (): MarkerPart => ({ type: "step-finish" })

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

const NOTICE = /CONTEXT WAS COMPRESSED/

const noticeText = (message: WithParts | undefined): string =>
    (message?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

interface Harness {
    sessionId: string
    manager: SessionStateManager
    run: (transcript: WithParts[]) => Promise<WithParts[]>
}

const createHarness = async (label: string): Promise<Harness> => {
    const sessionId = `session-notice-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await cleanupSessionFile(sessionId)
    const manager = new SessionStateManager()
    const state = manager.get(sessionId)
    state.initialized = true

    const refuseWrite = (method: string) => async () => {
        throw new Error(`the prompt transform must not call session.${method}`)
    }
    const handler = createChatMessageTransformHandler(
        {
            session: {
                get: async () => ({ data: {} }),
                prompt: refuseWrite("prompt"),
                update: refuseWrite("update"),
                messages: refuseWrite("messages"),
            },
        },
        manager,
        logger,
    )

    return {
        sessionId,
        manager,
        run: async (transcript: WithParts[]) => {
            const output = { messages: structuredClone(transcript) }
            await handler({}, output)
            return output.messages
        },
    }
}

describe("post-compression notice", () => {
    it("appends the notice as the final element of the first request after a compression", async () => {
        const harness = await createHarness("first")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a-compress", harness.sessionId, [
                    compressPart(),
                    stepFinishPart(),
                ]),
            ]

            const messages = await harness.run(transcript)

            assert.equal(messages.length, transcript.length + 1)
            const notice = messages[messages.length - 1]
            assert.equal(notice.info.role, "user")
            assert.match(noticeText(notice), NOTICE)
            assert.equal(noticeText(notice), renderPostCompressionNotice())
            assert.equal(messages.filter((message) => NOTICE.test(noticeText(message))).length, 1)
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("is not marked ignored and leaves the session transcript untouched", async () => {
        const harness = await createHarness("not-ignored")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a-compress", harness.sessionId, [compressPart()]),
            ]

            const messages = await harness.run(transcript)
            const notice = messages[messages.length - 1]

            assert.equal(isIgnoredUserMessage(notice), false)
            assert.equal(
                notice.parts.some((part) => "ignored" in part && part.ignored === true),
                false,
            )
            // The notice exists only in the request: it is a message the transcript never had,
            // and the transform added nothing else. The harness client throws on every session
            // write method, so reaching this point also proves nothing was written back.
            assert.equal(messages.length, transcript.length + 1)
            assert.equal(
                transcript.some((message) => message.info.id === notice.info.id),
                false,
            )
            assert.equal(
                messages
                    .slice(0, -1)
                    .every((message, index) => message.info.id === transcript[index].info.id),
                true,
            )
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("is recomputed rather than consumed, so a repeated request still carries it", async () => {
        const harness = await createHarness("repeat")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a-compress", harness.sessionId, [compressPart()]),
            ]

            for (let attempt = 0; attempt < 3; attempt++) {
                const messages = await harness.run(transcript)
                assert.match(noticeText(messages[messages.length - 1]), NOTICE)
            }
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("survives plugin status notifications, synthetic continuations, and ordinary user messages", async () => {
        const harness = await createHarness("artifacts")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a-compress", harness.sessionId, [compressPart()]),
                ignoredUserMessage(
                    "n1",
                    harness.sessionId,
                    "▣ Context Compress | ~12k saved total",
                ),
                syntheticContinuationMessage("g1", harness.sessionId),
                userMessage("u2", harness.sessionId, "Also check the logs"),
            ]

            const messages = await harness.run(transcript)

            assert.match(noticeText(messages[messages.length - 1]), NOTICE)
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("survives a failed turn and a native compaction summary that carry text", async () => {
        const harness = await createHarness("failed-turn")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a-compress", harness.sessionId, [compressPart()]),
                assistantMessage(
                    "a-failed",
                    harness.sessionId,
                    [textPart("Partial output before the request failed.")],
                    { error: { name: "ProviderError", message: "500" } },
                ),
                assistantMessage(
                    "a-native-summary",
                    harness.sessionId,
                    [textPart("Host-written conversation summary.")],
                    { summary: true },
                ),
            ]

            const messages = await harness.run(transcript)

            assert.match(noticeText(messages[messages.length - 1]), NOTICE)
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("survives a failure on the compressing message itself", async () => {
        const harness = await createHarness("failed-anchor")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage(
                    "a-compress",
                    harness.sessionId,
                    [compressPart(), textPart("Partial text streamed before the step failed.")],
                    { error: { name: "ProviderError", message: "500" } },
                ),
            ]

            const messages = await harness.run(transcript)

            assert.match(noticeText(messages[messages.length - 1]), NOTICE)
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("stays due after a failed turn that already ran a tool, and clears on the next completed turn", async () => {
        const harness = await createHarness("failed-with-work")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const readPart: ToolPart = {
                type: "tool",
                tool: "read",
                callID: "call-read",
                state: { status: "completed", input: {}, output: "file" },
            }
            const failedTurn = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a-compress", harness.sessionId, [compressPart()]),
                assistantMessage("a-failed", harness.sessionId, [readPart], {
                    error: { name: "ProviderError", message: "500" },
                }),
            ]

            // A request that does not complete leaves the notice due even though it managed
            // some work first: losing the notice is the worse failure.
            const retried = await harness.run(failedTurn)
            assert.match(noticeText(retried[retried.length - 1]), NOTICE)

            const completedTurn = [
                ...failedTurn,
                assistantMessage("a-retry", harness.sessionId, [readPart]),
            ]
            const resumed = await harness.run(completedTurn)
            assert.equal(
                resumed.some((message) => NOTICE.test(noticeText(message))),
                false,
            )
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("stops once the agent produces work in a later message", async () => {
        const harness = await createHarness("later-work")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a-compress", harness.sessionId, [compressPart()]),
                assistantMessage("a-next", harness.sessionId, [
                    textPart("Resuming the original task."),
                ]),
            ]

            const messages = await harness.run(transcript)

            assert.equal(
                messages.some((message) => NOTICE.test(noticeText(message))),
                false,
            )
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("stops when work follows the compress call inside the same assistant message", async () => {
        const harness = await createHarness("same-message")
        try {
            harness.manager.get(harness.sessionId).compressionCooldownAfterMessageId = "a-compress"
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a-compress", harness.sessionId, [
                    textPart("Compressing now."),
                    compressPart(),
                    {
                        type: "tool",
                        tool: "read",
                        callID: "call-read",
                        state: { status: "completed", input: {}, output: "file" },
                    },
                ]),
            ]

            const messages = await harness.run(transcript)

            assert.equal(
                messages.some((message) => NOTICE.test(noticeText(message))),
                false,
            )
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("is absent when no compression has succeeded in this session", async () => {
        const harness = await createHarness("none")
        try {
            const transcript = [
                userMessage("u1", harness.sessionId, "Do the work"),
                assistantMessage("a1", harness.sessionId, [textPart("On it.")]),
            ]

            const messages = await harness.run(transcript)

            assert.equal(
                messages.some((message) => NOTICE.test(noticeText(message))),
                false,
            )
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })

    it("appends after the compression transforms, so the rebuild cannot discard it", async () => {
        const harness = await createHarness("after-transform")
        try {
            const state = harness.manager.get(harness.sessionId)
            state.compressionCooldownAfterMessageId = "a-compress"
            state.compressed.messageIds = new Set(["u1", "a-old"])
            state.compressSummaries = [
                {
                    anchorMessageId: "u1",
                    messageIds: ["u1", "a-old"],
                    summary: "Durable block summary.",
                    topic: "Durable Block",
                },
            ]

            const transcript = [
                userMessage("u1", harness.sessionId, "Old request"),
                assistantMessage("a-old", harness.sessionId, [textPart("Old answer")]),
                userMessage("u2", harness.sessionId, "Compress now"),
                assistantMessage("a-compress", harness.sessionId, [compressPart()]),
            ]

            const messages = await harness.run(transcript)

            assert.match(noticeText(messages[messages.length - 1]), NOTICE)
            assert.equal(
                messages.some((message) => /Old answer/.test(noticeText(message))),
                false,
            )
            assert.equal(
                messages.some((message) => /Durable block summary/.test(noticeText(message))),
                true,
            )
        } finally {
            await cleanupSessionFile(harness.sessionId)
        }
    })
})
