import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"

import type { PluginConfig } from "../lib/config.ts"
import type { WithParts } from "../lib/state/types.ts"
import { fakeClient, isolateHostDirs, type PromptInput, type SyntheticInput } from "./helpers.ts"

const root = await isolateHostDirs()
const {
    extractManageCommandResidual,
    generateAutomaticPromptMessageId,
    generateManagePromptMessageId,
    handleManageCommand,
} = await import("../lib/commands/manage.ts")
const { Logger } = await import("../lib/logger.ts")
const { createSessionState, SessionStateManager } = await import("../lib/state/state.ts")
after(() => rm(root, { recursive: true, force: true }))

const logger = new Logger({ daily: false, context: false })

it("keeps automatic admission identity stable across unrelated prompt creation", () => {
    const trigger = {
        id: "assistant-threshold-crossing",
        sessionID: "session-a",
        role: "assistant" as const,
        time: { created: 1788599600000, completed: 1788599634450 },
    }
    const first = generateAutomaticPromptMessageId("session-a", trigger)
    generateManagePromptMessageId()
    assert.equal(generateAutomaticPromptMessageId("session-a", structuredClone(trigger)), first)
    assert.notEqual(generateAutomaticPromptMessageId("session-b", trigger), first)
    assert.notEqual(
        generateAutomaticPromptMessageId("session-a", { ...trigger, id: "next-step" }),
        first,
    )
    assert.match(first, /^msg_[0-9a-f]{26}$/)
})

const config: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "off",
    protectedTurns: 3,
    commands: {
        enabled: true,
    },
    autoCompression: {
        enabled: true,
        contextWindowRatio: 0.9,
        tokenThreshold: 300_000,
    },
    tools: {
        compress: {
            permission: "allow",
            showCompression: false,
        },
    },
}

const getSessionFilePath = (sessionId: string) =>
    join(root, "data", "opencode", "storage", "plugin", "compress", `${sessionId}.json`)

const cleanupSessionFile = async (sessionId: string) => {
    const filePath = getSessionFilePath(sessionId)
    if (existsSync(filePath)) {
        await rm(filePath)
    }
}

const createUserMessage = (sessionID: string): WithParts => ({
    info: {
        id: "m1",
        role: "user" as const,
        sessionID,
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
    it("does not open a management turn when compress is denied", async () => {
        const sessionId = `session-manage-tool-denied-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true
        let promptCalls = 0
        const feedback: SyntheticInput[] = []
        const client = fakeClient({
            synthetic: (input) => feedback.push(input),
            prompt: () => {
                promptCalls++
            },
        })
        const deniedConfig: PluginConfig = {
            ...config,
            tools: {
                ...config.tools,
                compress: { ...config.tools.compress, permission: "deny" },
            },
        }

        await handleManageCommand({
            client,
            stateManager: new SessionStateManager(),
            state,
            config: deniedConfig,
            logger,
            sessionId,
            messages: [createUserMessage(sessionId)],
            arguments: "manage",
        })

        assert.equal(promptCalls, 0)
        assert.equal(state.managementTurns.length, 0)
        assert.equal(feedback.length, 1)
        assert.match(feedback[0].text, /Enable the compression tool/)
    })

    it("sends a self-contained one-call reminder and anchors cleanup to the generated prompt message ID", async () => {
        const sessionId = `session-manage-command-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true

        let promptBody: PromptInput | undefined
        const client = fakeClient({
            prompt: (input) => {
                promptBody = input
            },
        })

        try {
            await handleManageCommand({
                client,
                stateManager: new SessionStateManager(),
                state,
                config,
                logger,
                sessionId,
                messages: [createUserMessage(sessionId)],
                arguments: "manage",
            })

            assert.ok(promptBody)
            const reminderText = promptBody.text
            const fullPayload = promptBody.text
            assert.match(reminderText, /<system-reminder>/)
            assert.match(
                reminderText,
                /call `compress` once, before this turn ends, with `summary` and `topic`/,
            )
            assert.match(reminderText, /A failure means nothing was compressed/)
            assert.doesNotMatch(reminderText, /compress_map|context-map/i)
            assert.doesNotMatch(fullPayload, /compress_map|context-map/i)
            assert.match(promptBody.id ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
            assert.equal(state.managementTurns.length, 1)
            assert.equal(state.managementTurns[0].triggerMessageId, promptBody.id)
            assert.deepEqual(promptBody.metadata, { "opencode.context-compress.management": true })
            assert.equal(state.managementTurns[0].cleanupVersion, 2)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("shows visible feedback and does not prompt when cleanup state cannot be saved", async () => {
        const sessionId = `session-manage-save-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const state = createSessionState()
        state.initialized = true
        state.persistenceSynchronized = true

        const feedback: SyntheticInput[] = []
        let promptCalls = 0
        const client = fakeClient({
            synthetic: (input) => feedback.push(input),
            prompt: () => {
                promptCalls++
            },
        })

        await handleManageCommand({
            client,
            stateManager: new SessionStateManager(),
            state,
            config,
            logger,
            sessionId,
            messages: [createUserMessage(sessionId)],
            arguments: "manage",
        })

        assert.equal(promptCalls, 0)
        assert.equal(state.managementTurns.length, 0)
        assert.equal(feedback.length, 1)
        assert.match(feedback[0].text, /Compression management could not start/)
    })

    it("does not start management when saved session state was not synchronized", async () => {
        const sessionId = `session-manage-load-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        const feedback: SyntheticInput[] = []
        let promptCalls = 0
        const client = fakeClient({
            synthetic: (input) => feedback.push(input),
            prompt: () => {
                promptCalls++
            },
        })

        await handleManageCommand({
            client,
            stateManager: new SessionStateManager(),
            state,
            config,
            logger,
            sessionId,
            messages: [createUserMessage(sessionId)],
            arguments: "manage",
        })

        assert.equal(promptCalls, 0)
        assert.equal(state.managementTurns.length, 0)
        assert.equal(feedback.length, 1)
        assert.match(feedback[0].text, /saved session state could not be loaded/)
    })

    it("shows visible feedback when the manage prompt throws", async () => {
        const sessionId = `session-manage-prompt-fails-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await cleanupSessionFile(sessionId)
        const state = createSessionState()
        state.sessionId = sessionId
        state.initialized = true
        state.persistenceSynchronized = true

        const feedback: SyntheticInput[] = []
        let promptCalls = 0
        const client = fakeClient({
            synthetic: (input) => feedback.push(input),
            prompt: () => {
                promptCalls++
                throw new Error("agent unavailable")
            },
        })

        try {
            await handleManageCommand({
                client,
                stateManager: new SessionStateManager(),
                state,
                config,
                logger,
                sessionId,
                messages: [createUserMessage(sessionId)],
                arguments: "manage",
            })

            assert.equal(promptCalls, 1)
            assert.equal(state.managementTurns.length, 0)
            assert.equal(feedback.length, 1)
            assert.match(feedback[0].text, /agent unavailable/)
        } finally {
            await cleanupSessionFile(sessionId)
        }
    })

    it("extracts mixed-content text after the manage invocation", () => {
        assert.equal(extractManageCommandResidual("manage"), undefined)
        assert.equal(
            extractManageCommandResidual("manage please compress the old context now"),
            undefined,
        )
        assert.equal(
            extractManageCommandResidual("manage Also, the launch window is June."),
            "Also, the launch window is June.",
        )
        assert.equal(
            extractManageCommandResidual(
                "manage please compress completed work; the launch window is June.",
            ),
            "the launch window is June.",
        )
        assert.equal(
            extractManageCommandResidual(
                "manage please compress completed work and the launch window is June.",
            ),
            "the launch window is June.",
        )
    })
})
