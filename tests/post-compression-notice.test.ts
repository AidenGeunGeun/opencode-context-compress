import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"

import type { ModelMessage } from "../lib/messages/v2-transform.ts"
import { renderPostCompressionNotice } from "../lib/prompts/index.ts"
import type {
    MarkerPart,
    Message,
    Part,
    SessionState,
    TextPart,
    ToolPart,
    WithParts,
} from "../lib/state/types.ts"
import { isolateHostDirs, modelRequest, modelText, startContextHook } from "./helpers.ts"

const root = await isolateHostDirs()
const { Logger } = await import("../lib/logger.ts")
const { setup } = await import("../lib/plugin.ts")
const { saveSessionState } = await import("../lib/state/persistence.ts")
const { createSessionState } = await import("../lib/state/state.ts")
after(() => rm(root, { recursive: true, force: true }))

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

const NOTICE = /CONTEXT WAS COMPRESSED/

const hasNotice = (messages: ModelMessage[]) =>
    messages.some((message) => NOTICE.test(modelText(message)))

interface Harness {
    sessionId: string
    run: (transcript: WithParts[]) => Promise<ModelMessage[]>
}

let sessionCounter = 0

// Runs the plugin's context hook on the model request built from each transcript. Session writes
// throw, so a passing run also proves the notice is never written back to the session.
const createHarness = async (durable: Partial<SessionState> = {}): Promise<Harness> => {
    const sessionId = `session-notice-${++sessionCounter}`
    await saveSessionState({ ...createSessionState(), sessionId, ...durable }, logger)
    const refuseWrite = (method: string) => () => {
        throw new Error(`the prompt transform must not call session.${method}`)
    }
    let transcript: WithParts[] = []
    const context = await startContextHook(setup, root, {
        context: async () => transcript,
        prompt: refuseWrite("prompt"),
        synthetic: refuseWrite("synthetic"),
    })
    return {
        sessionId,
        run: async (next) => {
            transcript = next
            const messages = modelRequest(next)
            await context(sessionId, messages)
            return messages
        },
    }
}

const compressed = { compressionCooldownAfterMessageId: "a-compress" }

describe("post-compression notice", () => {
    it("appends the notice as the final element of the first request after a compression", async () => {
        const harness = await createHarness(compressed)
        const transcript = [
            userMessage("u1", harness.sessionId, "Do the work"),
            assistantMessage("a-compress", harness.sessionId, [compressPart(), stepFinishPart()]),
        ]

        const messages = await harness.run(transcript)

        assert.deepEqual(
            messages.map((message) => message.id),
            ["u1", "a-compress", undefined],
        )
        // A plain user message: no ID ties it to the transcript, and no flag lets the host drop it.
        assert.deepEqual(messages.at(-1), {
            role: "user",
            content: [{ type: "text", text: renderPostCompressionNotice() }],
        })
        assert.equal(messages.filter((message) => NOTICE.test(modelText(message))).length, 1)
    })

    it("lives only in the model request and leaves the session transcript untouched", async () => {
        const harness = await createHarness(compressed)
        const transcript = [
            userMessage("u1", harness.sessionId, "Do the work"),
            assistantMessage("a-compress", harness.sessionId, [compressPart()]),
        ]
        const original = structuredClone(transcript)

        const messages = await harness.run(transcript)

        assert.match(modelText(messages.at(-1)), NOTICE)
        assert.deepEqual(transcript, original)
    })

    it("is recomputed rather than consumed, so a repeated request still carries it", async () => {
        const harness = await createHarness(compressed)
        const transcript = [
            userMessage("u1", harness.sessionId, "Do the work"),
            assistantMessage("a-compress", harness.sessionId, [compressPart()]),
        ]

        for (let attempt = 0; attempt < 3; attempt++) {
            const messages = await harness.run(transcript)
            assert.match(modelText(messages[messages.length - 1]), NOTICE)
        }
    })

    it("survives plugin status notifications, synthetic continuations, and ordinary user messages", async () => {
        const harness = await createHarness(compressed)
        const transcript = [
            userMessage("u1", harness.sessionId, "Do the work"),
            assistantMessage("a-compress", harness.sessionId, [compressPart()]),
            ignoredUserMessage("n1", harness.sessionId, "▣ Context Compress | ~12k saved total"),
            syntheticContinuationMessage("g1", harness.sessionId),
            userMessage("u2", harness.sessionId, "Also check the logs"),
        ]

        const messages = await harness.run(transcript)

        assert.match(modelText(messages[messages.length - 1]), NOTICE)
    })

    it("survives a failed turn and a native compaction summary that carry text", async () => {
        const harness = await createHarness(compressed)
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

        assert.match(modelText(messages[messages.length - 1]), NOTICE)
    })

    it("survives a failure on the compressing message itself", async () => {
        const harness = await createHarness(compressed)
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

        assert.match(modelText(messages[messages.length - 1]), NOTICE)
    })

    it("stays due after a failed turn that already ran a tool, and clears on the next completed turn", async () => {
        const harness = await createHarness(compressed)
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
        assert.match(modelText(retried[retried.length - 1]), NOTICE)

        const completedTurn = [
            ...failedTurn,
            assistantMessage("a-retry", harness.sessionId, [{ ...readPart, callID: "call-retry" }]),
        ]
        const resumed = await harness.run(completedTurn)
        assert.equal(hasNotice(resumed), false)
    })

    it("stops once the agent produces work in a later message", async () => {
        const harness = await createHarness(compressed)
        const transcript = [
            userMessage("u1", harness.sessionId, "Do the work"),
            assistantMessage("a-compress", harness.sessionId, [compressPart()]),
            assistantMessage("a-next", harness.sessionId, [
                textPart("Resuming the original task."),
            ]),
        ]

        const messages = await harness.run(transcript)

        assert.equal(hasNotice(messages), false)
    })

    it("stops when work follows the compress call inside the same assistant message", async () => {
        const harness = await createHarness(compressed)
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

        assert.equal(hasNotice(messages), false)
    })

    it("is absent when no compression has succeeded in this session", async () => {
        const harness = await createHarness()
        const transcript = [
            userMessage("u1", harness.sessionId, "Do the work"),
            assistantMessage("a1", harness.sessionId, [textPart("On it.")]),
        ]

        const messages = await harness.run(transcript)

        assert.equal(hasNotice(messages), false)
    })

    it("appends after the compression transforms, so the rebuild cannot discard it", async () => {
        const harness = await createHarness({
            ...compressed,
            compressed: { messageIds: new Set(["u1", "a-old"]), toolIds: new Set() },
            compressSummaries: [
                {
                    anchorMessageId: "u1",
                    messageIds: ["u1", "a-old"],
                    summary: "Durable block summary.",
                    topic: "Durable Block",
                },
            ],
        })

        const transcript = [
            userMessage("u1", harness.sessionId, "Old request"),
            assistantMessage("a-old", harness.sessionId, [textPart("Old answer")]),
            userMessage("u2", harness.sessionId, "Compress now"),
            assistantMessage("a-compress", harness.sessionId, [compressPart()]),
        ]

        const messages = await harness.run(transcript)

        assert.match(modelText(messages[messages.length - 1]), NOTICE)
        assert.equal(
            messages.some((message) => /Old answer/.test(modelText(message))),
            false,
        )
        assert.equal(
            messages.some((message) => /Durable block summary/.test(modelText(message))),
            true,
        )
    })
})
