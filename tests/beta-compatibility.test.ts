import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { after, describe, it } from "node:test"

import { type ContextMessage, isolateHostDirs } from "./helpers.ts"

const root = await isolateHostDirs()
const { adaptProjectedMessages } = await import("../lib/messages/v2-adapter.ts")
const { transformV2Messages } = await import("../lib/messages/v2-transform.ts")
const { SessionStateManager } = await import("../lib/state/state.ts")
after(() => rm(root, { recursive: true, force: true }))

function projected(): ContextMessage[] {
    return [
        { id: "old-user", type: "user", text: "older", files: [], time: { created: 1 } },
        {
            id: "old-assistant",
            type: "assistant",
            agent: "orchestrator",
            model: { providerID: "anthropic", id: "claude" },
            content: [{ type: "text", text: "older result" }],
            finish: "stop",
            tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 2, completed: 3 },
        },
        { id: "owner", type: "user", text: "compress now", files: [], time: { created: 4 } },
        {
            id: "tool-message",
            type: "assistant",
            agent: "orchestrator",
            model: { providerID: "anthropic", id: "claude" },
            content: [
                {
                    type: "tool",
                    id: "call-compress",
                    name: "compress",
                    state: {
                        status: "running",
                        input: { summary: "Earlier work", topic: "Earlier" },
                        metadata: {},
                    },
                    time: { created: 5 },
                },
            ],
            finish: "tool-calls",
            tokens: { input: 25, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 5 },
        },
    ]
}

describe("beta projected message compatibility", () => {
    it("preserves IDs, selection, nearest user ownership, tool calls, and ignored feedback", () => {
        const messages = adaptProjectedMessages(
            "session",
            [
                ...projected(),
                {
                    id: "feedback",
                    type: "synthetic",
                    text: "status",
                    metadata: { "opencode.context-compress.ignored": true },
                    time: { created: 6 },
                },
            ],
            {
                agent: "orchestrator",
                model: { providerID: "anthropic", id: "claude", variant: "high" },
            },
        )

        assert.deepEqual(
            messages.map((message) => message.info.id),
            ["old-user", "old-assistant", "owner", "tool-message", "feedback"],
        )
        const toolPart = messages[3].parts[1]
        const feedbackPart = messages[4].parts[0]
        assert.equal(messages[0].info.agent, "orchestrator")
        assert.equal(messages[3].info.parentID, "owner")
        assert.equal("callID" in toolPart ? toolPart.callID : undefined, "call-compress")
        assert.equal("ignored" in feedbackPart ? feedbackPart.ignored : undefined, true)
    })

    it("folds projected model context and removes ignored synthetic feedback", () => {
        const raw = adaptProjectedMessages("session", [
            ...projected().slice(0, 2),
            {
                id: "feedback",
                type: "synthetic",
                text: "status",
                metadata: { "opencode.context-compress.ignored": true },
                time: { created: 4 },
            },
        ])
        const state = new SessionStateManager().get("session")
        state.compressed.messageIds = new Set(["old-user", "old-assistant"])
        state.compressSummaries = [
            {
                anchorMessageId: "old-user",
                messageIds: ["old-user", "old-assistant"],
                summary: "Earlier work was completed.",
                topic: "Earlier work",
            },
        ]
        const transformed = transformV2Messages(raw, state, [
            { id: "old-user", role: "user", content: [{ type: "text", text: "older" }] },
            {
                id: "old-assistant",
                role: "assistant",
                content: [{ type: "text", text: "older result" }],
            },
            { id: "feedback", role: "user", content: [{ type: "text", text: "status" }] },
        ])

        assert.match(String(transformed[0].content[0].text), /\[b0\].*Earlier work/s)
        assert.equal(
            transformed.some((message) => message.id === "old-user"),
            false,
        )
        assert.equal(
            transformed.some((message) => message.id === "feedback"),
            false,
        )
    })

    it("restores non-user block anchors", () => {
        const anchors = [
            { id: "model-change", type: "model-switched", time: { created: 0 } },
            {
                id: "system-entry",
                type: "system",
                text: "Earlier instructions",
                time: { created: 0 },
            },
            projected()[1],
        ]

        for (const anchor of anchors) {
            const raw = adaptProjectedMessages("session", [
                anchor,
                projected()[0],
                { id: "later-model-change", type: "model-switched", time: { created: 3 } },
                projected()[2],
            ])
            const state = new SessionStateManager().get("session")
            state.compressed.messageIds = new Set([anchor.id, "old-user"])
            state.compressSummaries = [
                {
                    anchorMessageId: anchor.id,
                    messageIds: [anchor.id, "old-user"],
                    summary: "Earlier work was completed.",
                },
            ]
            const modelMessages = [
                { id: "old-user", role: "user", content: [{ type: "text", text: "older" }] },
                { id: "owner", role: "user", content: [{ type: "text", text: "compress now" }] },
            ]

            const transformed = transformV2Messages(raw, state, modelMessages)

            assert.equal(transformed.length, 2, anchor.type)
            assert.equal(transformed[0].role, "user")
            assert.match(
                String(transformed[0].content[0].text),
                /\[b0\].*Earlier work was completed/s,
            )
            assert.deepEqual(transformed[1], modelMessages[1])
            assert.deepEqual(transformV2Messages(raw, state, modelMessages), transformed)
            assert.equal(state.compressSummaries[0].anchorMessageId, anchor.id)
        }
    })

    it("keeps attached media objects intact", () => {
        const raw = adaptProjectedMessages("session", projected().slice(0, 2))
        const state = new SessionStateManager().get("session")
        class Asset {
            source = { type: "base64", data: "iVBORw0KGgo=" }
        }
        const media = new Asset()
        const transformed = transformV2Messages(raw, state, [
            {
                id: "old-user",
                role: "user",
                content: [
                    { type: "text", text: "older" },
                    { type: "media", media },
                ],
            },
            {
                id: "old-assistant",
                role: "assistant",
                content: [{ type: "text", text: "older result" }],
            },
        ])

        assert.equal(transformed[0].content[1].media, media)
    })

    it("keeps an idless effort marker where core placed it", () => {
        const raw = adaptProjectedMessages("session", [
            ...projected().slice(0, 2),
            { id: "variant-change", type: "model-switched", time: { created: 3 } },
            projected()[2],
        ])
        const state = new SessionStateManager().get("session")
        const marker = {
            role: "system",
            content: [{ type: "effort", effort: "high", previous: "max" }],
        }
        const owner = {
            id: "owner",
            role: "user",
            content: [{ type: "text", text: "compress now" }],
        }
        const modelMessages = [
            { id: "old-user", role: "user", content: [{ type: "text", text: "older" }] },
            {
                id: "old-assistant",
                role: "assistant",
                content: [{ type: "text", text: "older result" }],
            },
            marker,
            owner,
        ]

        assert.deepEqual(transformV2Messages(raw, state, modelMessages).slice(-2), [marker, owner])

        state.compressed.messageIds = new Set([
            "old-user",
            "old-assistant",
            "variant-change",
            "owner",
        ])
        state.compressSummaries = [
            {
                anchorMessageId: "old-user",
                messageIds: ["old-user", "old-assistant", "variant-change", "owner"],
                summary: "Earlier work was completed.",
            },
        ]
        const folded = transformV2Messages(raw, state, modelMessages)
        assert.equal(folded.length, 1)
        assert.match(String(folded[0].content[0].text), /\[b0\]/)
    })

    it("keeps a user message that carries only an image", () => {
        const raw = adaptProjectedMessages("session", [
            ...projected().slice(0, 2),
            {
                id: "image-only",
                type: "user",
                text: "",
                files: [{ mime: "image/png", name: "image.png", data: "iVBORw0KGgo=" }],
                time: { created: 4 },
            },
        ])
        const image = { id: "image-only", role: "user", content: [{ type: "media", media: {} }] }
        const transformed = transformV2Messages(raw, new SessionStateManager().get("session"), [
            { id: "old-user", role: "user", content: [{ type: "text", text: "older" }] },
            {
                id: "old-assistant",
                role: "assistant",
                content: [{ type: "text", text: "older result" }],
            },
            image,
        ])

        assert.deepEqual(transformed.at(-1), image)
    })

    it("preserves idless user and system inputs added by transient generation", () => {
        const raw = adaptProjectedMessages("session", projected().slice(0, 2))
        const state = new SessionStateManager().get("session")
        const transformed = transformV2Messages(raw, state, [
            { id: "old-user", role: "user", content: [{ type: "text", text: "older" }] },
            {
                id: "old-assistant",
                role: "assistant",
                content: [{ type: "text", text: "older result" }],
            },
            {
                role: "system",
                content: [{ type: "text", text: "Generate without mutating history" }],
            },
            { role: "user", content: [{ type: "text", text: "Transient generation prompt" }] },
        ])

        assert.deepEqual(transformed.slice(-2), [
            {
                role: "system",
                content: [{ type: "text", text: "Generate without mutating history" }],
            },
            { role: "user", content: [{ type: "text", text: "Transient generation prompt" }] },
        ])
    })
})
