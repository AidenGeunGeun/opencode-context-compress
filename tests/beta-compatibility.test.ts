import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { createAutomaticCompressionEventHandler } from "../lib/auto-compression.ts"
import type { PluginConfig } from "../lib/config.ts"
import { adaptProjectedMessages } from "../lib/messages/v2-adapter.ts"
import { transformV2Messages } from "../lib/messages/v2-transform.ts"
import { pluginClient } from "../lib/sdk/client.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import { createCompressTool } from "../lib/tools/compress.ts"
import { createSquashTool } from "../lib/tools/squash.ts"

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    saveContext: async () => {},
} as any

const config: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "off",
    notificationType: "chat",
    protectedTurns: 0,
    commands: { enabled: true },
    autoCompression: { enabled: true, contextWindowRatio: 0.9, tokenThreshold: 1 },
    tools: { compress: { permission: "allow", showCompression: false } },
}

function projected(sessionID: string) {
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
                    state: { status: "running", input: { summary: "Earlier work", topic: "Earlier" }, metadata: {} },
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
                ...projected("session"),
                {
                    id: "feedback",
                    type: "synthetic",
                    text: "status",
                    metadata: { "opencode.context-compress.ignored": true },
                    time: { created: 6 },
                },
            ],
            { agent: "orchestrator", model: { providerID: "anthropic", id: "claude", variant: "high" } },
        )

        assert.deepEqual(messages.map((message) => message.info.id), [
            "old-user",
            "old-assistant",
            "owner",
            "tool-message",
            "feedback",
        ])
        assert.equal((messages[0].info as any).agent, "orchestrator")
        assert.equal((messages[3].info as any).parentID, "owner")
        assert.equal((messages[3].parts[1] as any).callID, "call-compress")
        assert.equal((messages[4].parts[0] as any).ignored, true)
    })

    it("folds projected model context and removes ignored synthetic feedback", () => {
        const raw = adaptProjectedMessages("session", [
            ...projected("session").slice(0, 2),
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
        const transformed = transformV2Messages(raw, state, logger, [
            { id: "old-user", role: "user", content: [{ type: "text", text: "older" }] },
            { id: "old-assistant", role: "assistant", content: [{ type: "text", text: "older result" }] },
            { id: "feedback", role: "user", content: [{ type: "text", text: "status" }] },
        ])

        assert.match(String(transformed[0].content[0].text), /\[b0\].*Earlier work/s)
        assert.equal(transformed.some((message) => message.id === "old-user"), false)
        assert.equal(transformed.some((message) => message.id === "feedback"), false)
    })

    it("keeps attached media objects intact", () => {
        const raw = adaptProjectedMessages("session", projected("session").slice(0, 2))
        const state = new SessionStateManager().get("session")
        class Asset {
            source = { type: "base64", data: "iVBORw0KGgo=" }
        }
        const media = new Asset()
        const transformed = transformV2Messages(raw, state, logger, [
            { id: "old-user", role: "user", content: [{ type: "text", text: "older" }, { type: "media", media }] },
            { id: "old-assistant", role: "assistant", content: [{ type: "text", text: "older result" }] },
        ])

        assert.equal(transformed[0].content[1].media, media)
    })

    it("preserves idless user and system inputs added by transient generation", () => {
        const raw = adaptProjectedMessages("session", projected("session").slice(0, 2))
        const state = new SessionStateManager().get("session")
        const transformed = transformV2Messages(raw, state, logger, [
            { id: "old-user", role: "user", content: [{ type: "text", text: "older" }] },
            { id: "old-assistant", role: "assistant", content: [{ type: "text", text: "older result" }] },
            { role: "system", content: [{ type: "text", text: "Generate without mutating history" }] },
            { role: "user", content: [{ type: "text", text: "Transient generation prompt" }] },
        ])

        assert.deepEqual(transformed.slice(-2), [
            { role: "system", content: [{ type: "text", text: "Generate without mutating history" }] },
            { role: "user", content: [{ type: "text", text: "Transient generation prompt" }] },
        ])
    })
})

describe("beta tool and automatic lifecycle compatibility", () => {
    it("executes compress against projected history and persists the same state shape", async () => {
        const sessionID = `v2-compress-${Date.now()}-${Math.random()}`
        const values = projected(sessionID)
        const client = pluginClient({
            context: async () => values,
            prompt: async () => undefined,
            synthetic: async () => undefined,
        })
        const manager = new SessionStateManager()
        const tool = createCompressTool({ client, stateManager: manager, logger, config })

        try {
            const receipt = await tool.execute(
                { summary: "Earlier work", topic: "Earlier" },
                { sessionID, agent: "orchestrator", messageID: "tool-message", id: "call-compress" },
            )

            assert.match(receipt, /Compression complete/)
            assert.deepEqual(manager.get(sessionID).compressSummaries[0].messageIds, ["old-user", "old-assistant"])
            assert.equal(existsSync(sessionFile(sessionID)), true)
        } finally {
            await cleanup(sessionID)
        }
    })

    it("executes squash against projected block history without an authorization marker", async () => {
        const sessionID = `v2-squash-${Date.now()}-${Math.random()}`
        const values = [
            { id: "block-a", type: "user", text: "a", files: [], time: { created: 1 } },
            { id: "block-b", type: "user", text: "b", files: [], time: { created: 2 } },
            { id: "squash-trigger", type: "user", text: "squash", files: [], time: { created: 3 } },
            {
                id: "squash-message",
                type: "assistant",
                agent: "orchestrator",
                model: { providerID: "anthropic", id: "claude" },
                content: [
                    {
                        type: "tool",
                        id: "call-squash",
                        name: "squash",
                        state: { status: "running", input: {}, metadata: {} },
                    },
                ],
                tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 4 },
            },
        ]
        const client = pluginClient({
            context: async () => values,
            prompt: async () => undefined,
            synthetic: async () => undefined,
        })
        const manager = new SessionStateManager()
        const state = manager.get(sessionID)
        state.initialized = true
        state.persistenceSynchronized = true
        state.compressed.messageIds = new Set(["block-a", "block-b"])
        state.compressSummaries = [
            { anchorMessageId: "block-a", messageIds: ["block-a"], summary: "A", topic: "A" },
            { anchorMessageId: "block-b", messageIds: ["block-b"], summary: "B", topic: "B" },
        ]
        const tool = createSquashTool({ client, stateManager: manager, logger, config })

        try {
            const receipt = await tool.execute(
                { from: "b0", to: "b1", summary: "Combined", topic: "Combined" },
                { sessionID, agent: "orchestrator", messageID: "squash-message", id: "call-squash" },
            )

            assert.match(receipt, /Squash complete/)
            assert.equal(state.compressSummaries.length, 1)
            assert.deepEqual(state.compressSummaries[0].messageIds, ["block-a", "block-b"])
        } finally {
            await cleanup(sessionID)
        }
    })

    it("starts automatic compression when a hot reload observed only the V2 step end", async () => {
        const sessionID = `v2-auto-${Date.now()}-${Math.random()}`
        const values = projected(sessionID).slice(0, 2)
        const prompts: unknown[] = []
        const client = pluginClient({
            context: async () => values,
            prompt: async (input) => void prompts.push(input),
            synthetic: async () => undefined,
        })
        const manager = new SessionStateManager()
        manager.get(sessionID).modelContext = { providerId: "anthropic", modelId: "claude", contextLimit: 1_000 }
        const handler = createAutomaticCompressionEventHandler(client, manager, logger, config)

        try {
            await handler({
                type: "session.step.ended",
                data: {
                    sessionID,
                    assistantMessageID: "old-assistant",
                    tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
                },
            })

            assert.equal(prompts.length, 1)
            assert.equal(manager.get(sessionID).managementTurns[0]?.source, "automatic")
        } finally {
            await cleanup(sessionID)
        }
    })

    it("admits automatic compression only from the matching V2 workspace", async () => {
        const sessionID = `v2-location-${Date.now()}-${Math.random()}`
        const values = projected(sessionID).slice(0, 2)
        const prompts: unknown[] = []
        const client = pluginClient({
            context: async () => values,
            prompt: async (input) => void prompts.push(input),
            synthetic: async () => undefined,
        })
        const matching = new SessionStateManager()
        const other = new SessionStateManager()
        matching.get(sessionID).modelContext = { providerId: "anthropic", modelId: "claude", contextLimit: 1_000 }
        other.get(sessionID).modelContext = { providerId: "anthropic", modelId: "claude", contextLimit: 1_000 }
        const handlers = [
            createAutomaticCompressionEventHandler(
                client,
                matching,
                logger,
                config,
                async (_sessionID, event) => {
                    const location = (event as { location?: { directory: string; workspaceID?: string } }).location
                    return location?.directory === "/matching" && location.workspaceID === "workspace-a"
                },
            ),
            createAutomaticCompressionEventHandler(
                client,
                other,
                logger,
                config,
                async (_sessionID, event) => {
                    const location = (event as { location?: { directory: string; workspaceID?: string } }).location
                    return location?.directory === "/matching" && location.workspaceID === "workspace-b"
                },
            ),
        ]

        try {
            for (const handler of handlers) {
                await handler({
                    type: "session.step.started",
                    data: {
                        sessionID,
                        assistantMessageID: "old-assistant",
                        agent: "orchestrator",
                        model: { providerID: "anthropic", id: "claude" },
                    },
                })
                await handler({
                    type: "session.step.ended",
                    location: { directory: "/matching", workspaceID: "workspace-a" },
                    data: {
                        sessionID,
                        assistantMessageID: "old-assistant",
                        tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
                    },
                })
            }

            assert.equal(prompts.length, 1)
            assert.equal(matching.get(sessionID).managementTurns.length, 1)
            assert.equal(other.get(sessionID).managementTurns.length, 0)
        } finally {
            await cleanup(sessionID)
        }
    })
})

function sessionFile(sessionID: string) {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "compress",
        `${sessionID}.json`,
    )
}

async function cleanup(sessionID: string) {
    const path = sessionFile(sessionID)
    if (existsSync(path)) await rm(path)
}
