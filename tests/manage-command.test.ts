import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { handleManageCommand } from "../lib/commands/manage.ts"
import type { PluginConfig } from "../lib/config.ts"
import { createSessionState } from "../lib/state/state.ts"

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
} as any

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

const createUserMessage = () => ({
    info: {
        id: "m1",
        role: "user" as const,
        sessionID: "session-test",
        agent: "agent-test",
        model: {
            providerID: "openai",
            modelID: "gpt-5.4",
        },
        time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "Please manage context" }],
})

describe("handleManageCommand", () => {
    it("sends a lean reminder without embedding the context map", async () => {
        const state = createSessionState()
        state.sessionId = "session-test"
        state.initialized = true

        let payload = ""
        const client = {
            session: {
                prompt: async (input: any) => {
                    payload = input.body.parts[0].text
                },
            },
        }

        await handleManageCommand({
            client,
            state,
            config,
            logger,
            sessionId: "session-test",
            messages: [createUserMessage()] as any,
        })

        const nonEmptyLines = payload.split("\n").filter((line) => line.trim().length > 0)

        assert.match(payload, /<system-reminder>/)
        assert.match(payload, /compress_map/)
        assert.match(payload, /compress/)
        assert.doesNotMatch(payload, /<compress-context-map>/)
        assert.ok(nonEmptyLines.length <= 15, `expected <= 15 non-empty lines, got ${nonEmptyLines.length}`)
    })
})
