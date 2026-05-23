import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2"

import {
    getSession,
    listSessionMessages,
    promptSession,
    showToast,
} from "../lib/sdk/client.ts"

describe("SDK client adapter", () => {
    it("uses nested v1 request shapes for plugin host clients", async () => {
        const calls: unknown[] = []
        const client = {
            _client: {},
            session: {
                get: async (input: unknown) => {
                    calls.push(["get", input])
                    return { data: { id: "session-1", parentID: "parent-1" } }
                },
                messages: async (input: unknown) => {
                    calls.push(["messages", input])
                    return { data: [{ info: { id: "m1" }, parts: [] }] }
                },
                prompt: async (input: unknown) => {
                    calls.push(["prompt", input])
                    return { data: { info: { id: "m2", parentID: "m1" } } }
                },
            },
            tui: {
                showToast: async (input: unknown) => {
                    calls.push(["toast", input])
                },
            },
        }

        const session = await getSession(client, "session-1")
        const messages = await listSessionMessages(client, "session-1")
        await promptSession(client, {
            sessionId: "session-1",
            parts: [{ type: "text", text: "hello" }],
            noReply: true,
        })
        await showToast(client, {
            title: "Test",
            message: "toast",
            variant: "info",
        })

        assert.equal(session?.parentID, "parent-1")
        assert.equal(messages.length, 1)
        assert.deepEqual(calls[0], ["get", { path: { id: "session-1" } }])
        assert.deepEqual(calls[1], ["messages", { path: { id: "session-1" } }])
        assert.deepEqual(calls[2], [
            "prompt",
            {
                path: { id: "session-1" },
                body: {
                    parts: [{ type: "text", text: "hello" }],
                    agent: undefined,
                    model: undefined,
                    variant: undefined,
                    noReply: true,
                    messageID: undefined,
                },
            },
        ])
        assert.deepEqual(calls[3], [
            "toast",
            {
                body: {
                    title: "Test",
                    message: "toast",
                    variant: "info",
                    duration: undefined,
                },
            },
        ])
    })

    it("uses flat v2 request shapes for v2 SDK clients", async () => {
        const calls: unknown[] = []
        const client = createV2Client({ baseUrl: "http://127.0.0.1:0" })
        client.session.get = (async (input: unknown) => {
            calls.push(["get", input])
            return { data: { id: "session-2" } }
        }) as typeof client.session.get
        client.session.messages = (async (input: unknown) => {
            calls.push(["messages", input])
            return { data: [] }
        }) as typeof client.session.messages
        client.session.prompt = (async (input: unknown) => {
            calls.push(["prompt", input])
            return { data: { info: { id: "m3" } } }
        }) as typeof client.session.prompt
        client.tui.showToast = (async (input: unknown) => {
            calls.push(["toast", input])
        }) as typeof client.tui.showToast

        await getSession(client, "session-2")
        await listSessionMessages(client, "session-2", { limit: 5 })
        await promptSession(client, {
            sessionId: "session-2",
            parts: [{ type: "text", text: "v2" }],
        })
        await showToast(client, {
            message: "v2 toast",
            variant: "warning",
        })

        assert.deepEqual(calls[0], ["get", { sessionID: "session-2" }])
        assert.deepEqual(calls[1], ["messages", { sessionID: "session-2", limit: 5 }])
        assert.deepEqual(calls[2], [
            "prompt",
            {
                sessionID: "session-2",
                parts: [{ type: "text", text: "v2" }],
                agent: undefined,
                model: undefined,
                variant: undefined,
                noReply: undefined,
                messageID: undefined,
            },
        ])
        assert.deepEqual(calls[3], [
            "toast",
            {
                title: undefined,
                message: "v2 toast",
                variant: "warning",
                duration: undefined,
                directory: undefined,
            },
        ])
    })

    it("detects installed SDK client generations", () => {
        const v1Client = createOpencodeClient({ baseUrl: "http://127.0.0.1:0" })
        const v2Client = createV2Client({ baseUrl: "http://127.0.0.1:0" })

        assert.equal("_client" in v1Client, true)
        assert.equal("client" in v2Client, true)
    })
})
