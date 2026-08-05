import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    createReportNudgeEventHandler,
    injectReportNudge,
    resolveReportNudge,
} from "../lib/report-nudge.ts"
import { DEFAULT_AUTO_COMPRESSION, DEFAULT_REPORT_NUDGE, type PluginConfig } from "../lib/config.ts"
import { SessionStateManager, createSessionState } from "../lib/state/state.ts"
import { applyCompressTransforms } from "../lib/messages/index.ts"
import { createChatMessageTransformHandler } from "../lib/hooks.ts"
import { Logger } from "../lib/logger.ts"
import { renderSquashSystemPrompt } from "../lib/prompts/index.ts"
import { renderGoalOverflowRecoveryPrompt } from "../lib/goal.ts"
import type { WithParts } from "../lib/state/index.ts"

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
} as any

const baseConfig: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "off",
    notificationType: "chat",
    protectedTurns: 3,
    commands: { enabled: true },
    autoCompression: { ...DEFAULT_AUTO_COMPRESSION },
    reportNudge: { enabled: true, tokenInterval: 100_000 },
    tools: {
        compress: { permission: "allow", showCompression: false },
    },
}

const userMessage = (id: string, sessionID: string, text: string): WithParts =>
    ({
        info: {
            id,
            sessionID,
            role: "user" as const,
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-test" },
            time: { created: Date.now() },
        },
        parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text }],
    }) as unknown as WithParts

const assistantMessage = (id: string, sessionID: string): WithParts =>
    ({
        info: {
            id,
            sessionID,
            role: "assistant" as const,
            time: { created: Date.now(), completed: Date.now() },
        },
        parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: "ok" }],
    }) as unknown as WithParts

const assistantEvent = (id: string, sessionID: string, total: number, overrides: Record<string, unknown> = {}) => ({
    event: {
        type: "message.updated",
        properties: {
            info: {
                id,
                sessionID,
                role: "assistant",
                time: { completed: Date.now() },
                tokens: { total },
                ...overrides,
            },
        },
    },
})

describe("resolveReportNudge", () => {
    it("defaults to a 100,000 token interval and stays off until a profile enables it", () => {
        assert.equal(DEFAULT_REPORT_NUDGE.tokenInterval, 100_000)
        assert.equal(DEFAULT_REPORT_NUDGE.enabled, false)
    })

    it("records bucket zero without firing below the first absolute boundary", () => {
        const result = resolveReportNudge(40_000, undefined, 100_000)
        assert.equal(result.due, false)
        assert.equal(result.bucket, 0)
    })

    it("fires exactly at the first absolute 100,000-token boundary", () => {
        const before = resolveReportNudge(99_999, 0, 100_000)
        const at = resolveReportNudge(100_000, before.bucket, 100_000)

        assert.equal(before.due, false)
        assert.equal(at.due, true)
        assert.equal(at.bucket, 1)
    })

    it("does not repeat within a bucket and fires again at 200,000", () => {
        assert.deepEqual(resolveReportNudge(150_000, 1, 100_000), { due: false, bucket: 1 })
        assert.deepEqual(resolveReportNudge(199_999, 1, 100_000), { due: false, bucket: 1 })
        assert.deepEqual(resolveReportNudge(200_000, 1, 100_000), { due: true, bucket: 2 })
    })

    it("drops to bucket zero after compression so 100,000 can fire again", () => {
        const afterCompression = resolveReportNudge(30_000, 3, 100_000)
        assert.equal(afterCompression.due, false)
        assert.equal(afterCompression.bucket, 0)

        const next = resolveReportNudge(100_000, afterCompression.bucket, 100_000)
        assert.equal(next.due, true)
        assert.equal(next.bucket, 1)
    })

    it("ignores unusable usage readings without moving the bucket", () => {
        assert.deepEqual(resolveReportNudge(0, 1, 100_000), { due: false, bucket: 1 })
        assert.deepEqual(resolveReportNudge(Number.NaN, 1, 100_000), { due: false, bucket: 1 })
    })

    it("fires on a first usable reading already beyond the boundary", () => {
        const first = resolveReportNudge(0, undefined, 100_000)
        assert.equal(first.bucket, undefined)

        const second = resolveReportNudge(120_000, first.bucket, 100_000)
        assert.equal(second.due, true)
        assert.equal(second.bucket, 1)
    })

    it("never fires on an interval that configuration validation already rejected", () => {
        assert.equal(resolveReportNudge(500_000, 1, 0).due, false)
        assert.equal(resolveReportNudge(500_000, 1, -1).due, false)
        assert.equal(resolveReportNudge(500_000, 1, Number.NaN).due, false)
    })
})

describe("report nudge event handler", () => {
    it("does nothing while the feature is disabled", async () => {
        const stateManager = new SessionStateManager()
        const handler = createReportNudgeEventHandler(stateManager, logger, {
            ...baseConfig,
            reportNudge: { enabled: false, tokenInterval: 100_000 },
        })

        await handler(assistantEvent("m1", "ses_disabled", 500_000))

        const state = stateManager.get("ses_disabled")
        assert.equal(state.reportNudgePending, undefined)
        assert.equal(state.reportNudgeBucket, undefined)
    })

    it("queues a nudge at the absolute 100,000-token boundary", async () => {
        const stateManager = new SessionStateManager()
        const handler = createReportNudgeEventHandler(stateManager, logger, baseConfig)
        const sessionId = "ses_growth"

        await handler(assistantEvent("m1", sessionId, 20_000))
        assert.equal(stateManager.get(sessionId).reportNudgePending, undefined)

        await handler(assistantEvent("m2", sessionId, 90_000))
        assert.equal(stateManager.get(sessionId).reportNudgePending, undefined)

        await handler(assistantEvent("m3", sessionId, 100_000))
        assert.equal(stateManager.get(sessionId).reportNudgePending, true)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 1)
    })

    it("ignores messages that are not completed assistant work", async () => {
        const stateManager = new SessionStateManager()
        const handler = createReportNudgeEventHandler(stateManager, logger, baseConfig)
        const sessionId = "ses_filtered"

        await handler(assistantEvent("m1", sessionId, 10_000))
        await handler(assistantEvent("m2", sessionId, 500_000, { role: "user" }))
        await handler(assistantEvent("m3", sessionId, 500_000, { summary: true }))
        await handler(assistantEvent("m4", sessionId, 500_000, { error: { name: "boom" } }))
        await handler(assistantEvent("m5", sessionId, 500_000, { time: {} }))

        assert.equal(stateManager.get(sessionId).reportNudgePending, undefined)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 0)
    })

    it("queues from a first usable reading already beyond 100,000", async () => {
        const stateManager = new SessionStateManager()
        const handler = createReportNudgeEventHandler(stateManager, logger, baseConfig)
        const sessionId = "ses_no_usage"

        await handler(assistantEvent("m1", sessionId, 0, { tokens: undefined }))
        await handler(assistantEvent("m2", sessionId, 150_000))

        assert.equal(stateManager.get(sessionId).reportNudgePending, true)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 1)
    })

    it("ignores unrelated events", async () => {
        const stateManager = new SessionStateManager()
        const handler = createReportNudgeEventHandler(stateManager, logger, baseConfig)

        await handler({ event: { type: "session.idle", properties: {} } } as any)
        assert.equal(stateManager.get("ses_other").reportNudgeBucket, undefined)
    })
})

describe("report nudge injection", () => {
    it("appends the reminder to the last visible user message and clears the flag", () => {
        const state = createSessionState()
        state.reportNudgePending = true
        const messages = [
            userMessage("u1", "ses_inject", "first"),
            assistantMessage("a1", "ses_inject"),
            userMessage("u2", "ses_inject", "second"),
            assistantMessage("a2", "ses_inject"),
        ]

        assert.equal(injectReportNudge(state, logger, messages), true)
        assert.equal(state.reportNudgePending, false)

        assert.equal(messages[0].parts.length, 1)
        assert.equal(messages[2].parts.length, 2)
        const injected = messages[2].parts[1] as any
        assert.equal(injected.type, "text")
        assert.match(injected.text, /HANDOFF REPORT CHECKPOINT/)
        assert.equal(injected.messageID, "u2")
    })

    it("does nothing when no nudge is pending", () => {
        const state = createSessionState()
        const messages = [userMessage("u1", "ses_idle", "hello")]

        assert.equal(injectReportNudge(state, logger, messages), false)
        assert.equal(messages[0].parts.length, 1)
    })

    it("keeps the nudge pending when there is no visible user message to carry it", () => {
        const state = createSessionState()
        state.reportNudgePending = true
        const messages = [assistantMessage("a1", "ses_empty")]

        assert.equal(injectReportNudge(state, logger, messages), false)
        assert.equal(state.reportNudgePending, true)
    })

    it("spends the nudge on an active compression turn, which already asks for the update", () => {
        const state = createSessionState()
        state.reportNudgePending = true
        const trigger = userMessage("mgmt1", "ses_busy", "compress now")
        state.managementTurns = [{ triggerMessageId: "mgmt1" }]
        const messages = [userMessage("u1", "ses_busy", "work"), trigger]

        assert.equal(injectReportNudge(state, logger, messages), false)
        assert.equal(messages[1].parts.length, 1)
        // Deferring instead would deliver a duplicate reminder once compression finished.
        assert.equal(state.reportNudgePending, false)
        assert.equal(injectReportNudge(state, logger, messages), false)
    })

    it("is safe to spend on a squash turn because that prompt carries the instruction too", () => {
        const state = createSessionState()
        state.reportNudgePending = true
        state.managementTurns = [{ triggerMessageId: "mgmt1", source: "squash" }]
        const messages = [
            userMessage("u1", "ses_squash", "work"),
            userMessage("mgmt1", "ses_squash", "squash now"),
        ]

        assert.match(renderSquashSystemPrompt(), /handoff report file/i)
        assert.equal(injectReportNudge(state, logger, messages), false)
        assert.equal(state.reportNudgePending, false)
    })

    it("is safe to spend on Goal overflow recovery for the same reason", () => {
        assert.match(renderGoalOverflowRecoveryPrompt(), /handoff report file/i)
    })

    it("is delivered by the real transform hook, once, across consecutive steps", async () => {
        const sessionId = `ses-nudge-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const stateManager = new SessionStateManager()
        const handler = createChatMessageTransformHandler(
            { session: { get: async () => ({ data: {} }) } },
            stateManager,
            new Logger({ daily: false, context: false }),
            "/tmp/report-nudge",
        )

        const firstStep = { messages: [userMessage("u1", sessionId, "work")] as any[] }
        await handler({}, firstStep)
        assert.equal(firstStep.messages[0].parts.length, 1)

        stateManager.get(sessionId).reportNudgePending = true

        const secondStep = { messages: [userMessage("u1", sessionId, "work")] as any[] }
        await handler({}, secondStep)
        assert.equal(secondStep.messages[0].parts.length, 2)
        assert.match((secondStep.messages[0].parts[1] as any).text, /HANDOFF REPORT CHECKPOINT/)

        // Next step of the same tool loop: one crossing must not nag repeatedly.
        const thirdStep = { messages: [userMessage("u1", sessionId, "work")] as any[] }
        await handler({}, thirdStep)
        assert.equal(thirdStep.messages[0].parts.length, 1)
    })

    it("survives the compress transform and lands on the message the model actually sees", () => {
        const state = createSessionState()
        state.reportNudgePending = true
        const sessionID = "ses_transform"
        const messages = [
            userMessage("u1", sessionID, "old work"),
            assistantMessage("a1", sessionID),
            userMessage("u2", sessionID, "current work"),
        ]
        state.compressed.messageIds = new Set(["a1"])
        state.compressSummaries = [
            {
                anchorMessageId: "a1",
                messageIds: ["a1"],
                summary: "earlier work",
                topic: "earlier",
            },
        ]

        applyCompressTransforms(state, logger, messages)
        assert.equal(injectReportNudge(state, logger, messages), true)

        const last = messages[messages.length - 1]
        assert.equal(last.info.role, "user")
        assert.equal(last.parts.length, 2)
        assert.match((last.parts[1] as any).text, /HANDOFF REPORT CHECKPOINT/)
        assert.equal(
            messages.filter((message) =>
                message.parts.some((part: any) => /HANDOFF REPORT CHECKPOINT/.test(part.text ?? "")),
            ).length,
            1,
        )
    })
})
