import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { listSessionMessages, promptSession, setSessionSelection } from "../lib/sdk/client.ts"
import { fakeClient, type PromptInput, type SyntheticInput } from "./helpers.ts"

describe("beta Promise session adapter", () => {
    it("projects session.context history with the current selection", async () => {
        const client = fakeClient({
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
        })
        setSessionSelection(client, "session", {
            agent: "build",
            model: { providerID: "openai", id: "gpt-test", variant: "high" },
        })

        const messages = await listSessionMessages(client, "session")
        assert.deepEqual(
            messages.map((message) => message.info.id),
            ["user", "assistant"],
        )
        assert.equal(messages[0].info.variant, "high")
        assert.equal(messages[1].info.parentID, "user")
    })

    it("uses prompt for model work and admit-only synthetic feedback", async () => {
        const prompts: PromptInput[] = []
        const feedback: SyntheticInput[] = []
        const client = fakeClient({
            prompt: (input) => prompts.push(input),
            synthetic: (input) => feedback.push(input),
        })

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

        assert.equal(prompts.length, 1)
        assert.equal(feedback.length, 1)
        assert.equal(prompts[0].sessionID, "session")
        assert.equal(prompts[0].id, "message")
        assert.equal(prompts[0].text, "manage")
        assert.equal(prompts[0].delivery, "steer")
        assert.equal(prompts[0].resume, true)
        assert.equal(feedback[0].sessionID, "session")
        assert.equal(feedback[0].text, "status")
        assert.equal(feedback[0].resume, false)
        assert.equal(feedback[0].metadata?.["opencode.context-compress.ignored"], true)
    })
})
