import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
    listSessionMessages,
    pluginClient,
    promptSession,
    setSessionSelection,
} from "../lib/sdk/client.ts"

describe("beta Promise session adapter", () => {
    it("projects session.context history with the current selection", async () => {
        const client = pluginClient({
            context: async () => [
                { id: "user", type: "user", text: "hello", time: { created: 1 } },
                { id: "idle", type: "idle", outcome: "failed", time: { created: 2 } },
                {
                    id: "assistant",
                    type: "assistant",
                    agent: "build",
                    model: { providerID: "openai", id: "gpt-test" },
                    content: [{ type: "text", text: "done" }],
                    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: 2, completed: 3 },
                },
            ],
            prompt: async () => undefined,
            synthetic: async () => undefined,
            wait: async () => undefined,
        } as any)
        setSessionSelection(client, "session", {
            agent: "build",
            model: { providerID: "openai", id: "gpt-test", variant: "high" },
        })

        const messages = await listSessionMessages(client, "session") as any[]
        assert.deepEqual(messages.map((message) => message.info.id), ["user", "assistant"])
        assert.equal(messages[0].info.variant, "high")
        assert.equal(messages[1].info.parentID, "user")
    })

    it("uses prompt for model work and admit-only synthetic feedback", async () => {
        const calls: Array<[string, unknown]> = []
        const client = pluginClient({
            context: async () => [],
            prompt: async (input) => void calls.push(["prompt", input]),
            synthetic: async (input) => void calls.push(["synthetic", input]),
            wait: async (input) => void calls.push(["wait", input]),
        } as any)

        await promptSession(client, {
            sessionId: "session",
            messageId: "message",
            parts: [{ type: "text", text: "manage" }],
        })
        await promptSession(client, {
            sessionId: "session",
            noReply: true,
            parts: [{ type: "text", text: "status" }],
        })

        assert.deepEqual(calls, [
            ["prompt", { sessionID: "session", text: "manage", id: "message", delivery: "steer", resume: true }],
            ["synthetic", {
                sessionID: "session",
                text: "status",
                description: "status",
                metadata: { "opencode.context-compress.ignored": true },
                resume: false,
            }],
        ])
    })
})
