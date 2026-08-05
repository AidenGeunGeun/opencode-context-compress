import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    createReportNudgeEventHandler,
    resolveReportNudge,
} from "../lib/report-nudge.ts"
import { DEFAULT_AUTO_COMPRESSION, DEFAULT_REPORT_NUDGE, type PluginConfig } from "../lib/config.ts"
import { SessionStateManager, createSessionState } from "../lib/state/state.ts"
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

const reportClient = (sessionID: string, prompts: string[]) => ({
    session: {
        messages: async () => [userMessage("u1", sessionID, "work")],
        prompt: async (input: any) => {
            prompts.push(input.body?.parts?.[0]?.text ?? input.parts?.[0]?.text ?? "")
            return { data: { info: { id: `report-${prompts.length}` } } }
        },
    },
    tui: { showToast: async () => undefined },
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
        const prompts: string[] = []
        const sessionId = "ses_disabled"
        const handler = createReportNudgeEventHandler(reportClient(sessionId, prompts), stateManager, logger, {
            ...baseConfig,
            reportNudge: { enabled: false, tokenInterval: 100_000 },
        })

        await handler(assistantEvent("m1", sessionId, 500_000))

        assert.equal(prompts.length, 0)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, undefined)
    })

    it("opens one visible report turn at each absolute context boundary", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const sessionId = "ses_boundaries"
        const handler = createReportNudgeEventHandler(
            reportClient(sessionId, prompts),
            stateManager,
            logger,
            baseConfig,
        )

        await handler(assistantEvent("m1", sessionId, 20_000))
        await handler(assistantEvent("m2", sessionId, 99_999))
        assert.equal(prompts.length, 0)

        await handler(assistantEvent("m3", sessionId, 100_000))
        assert.equal(prompts.length, 1)
        assert.match(prompts[0], /HANDOFF REPORT CHECKPOINT/)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 1)
        assert.equal(stateManager.get(sessionId).reportNudgePending, false)

        await handler(assistantEvent("m4", sessionId, 150_000))
        assert.equal(prompts.length, 1)

        await handler(assistantEvent("m5", sessionId, 200_000))
        assert.equal(prompts.length, 2)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 2)
    })

    it("ignores messages that are not completed assistant work", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const sessionId = "ses_filtered"
        const handler = createReportNudgeEventHandler(
            reportClient(sessionId, prompts),
            stateManager,
            logger,
            baseConfig,
        )

        await handler(assistantEvent("m1", sessionId, 10_000))
        await handler(assistantEvent("m2", sessionId, 500_000, { role: "user" }))
        await handler(assistantEvent("m3", sessionId, 500_000, { summary: true }))
        await handler(assistantEvent("m4", sessionId, 500_000, { error: { name: "boom" } }))
        await handler(assistantEvent("m5", sessionId, 500_000, { time: {} }))

        assert.equal(prompts.length, 0)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 0)
    })

    it("opens immediately from a first usable reading already beyond 100,000", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const sessionId = "ses_no_usage"
        const handler = createReportNudgeEventHandler(
            reportClient(sessionId, prompts),
            stateManager,
            logger,
            baseConfig,
        )

        await handler(assistantEvent("m1", sessionId, 0, { tokens: undefined }))
        await handler(assistantEvent("m2", sessionId, 150_000))

        assert.equal(prompts.length, 1)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 1)
    })

    it("lets an active compression turn carry the report instruction instead", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const sessionId = "ses_management"
        const state = stateManager.get(sessionId)
        state.managementTurns = [{ triggerMessageId: "mgmt1" }]
        const client = {
            ...reportClient(sessionId, prompts),
            session: {
                ...reportClient(sessionId, prompts).session,
                messages: async () => [
                    userMessage("u1", sessionId, "work"),
                    userMessage("mgmt1", sessionId, "compress now"),
                ],
            },
        }
        const handler = createReportNudgeEventHandler(client, stateManager, logger, baseConfig)

        await handler(assistantEvent("m1", sessionId, 100_000))

        assert.equal(prompts.length, 0)
        assert.equal(state.reportNudgePending, false)
        assert.match(renderSquashSystemPrompt(), /handoff report file/i)
        assert.match(renderGoalOverflowRecoveryPrompt(), /handoff report file/i)
    })

    it("keeps a failed automatic report request pending and retries on the next assistant event", async () => {
        const stateManager = new SessionStateManager()
        const sessionId = "ses_retry"
        const prompts: string[] = []
        let attempts = 0
        const client = {
            session: {
                messages: async () => [userMessage("u1", sessionId, "work")],
                prompt: async (input: any) => {
                    attempts++
                    prompts.push(input.body?.parts?.[0]?.text ?? input.parts?.[0]?.text ?? "")
                    return attempts === 1
                        ? { error: { message: "busy" } }
                        : { data: { info: { id: "report-ok" } } }
                },
            },
            tui: { showToast: async () => undefined },
        }
        const handler = createReportNudgeEventHandler(client, stateManager, logger, baseConfig)

        await handler(assistantEvent("m1", sessionId, 100_000))
        assert.equal(attempts, 1)
        assert.equal(stateManager.get(sessionId).reportNudgePending, true)
        assert.equal(stateManager.get(sessionId).reportNudgeStarting, false)

        await handler(assistantEvent("m2", sessionId, 101_000))
        assert.equal(attempts, 2)
        assert.equal(stateManager.get(sessionId).reportNudgePending, false)
        assert.equal(stateManager.get(sessionId).reportNudgeStarting, false)
    })

    it("ignores unrelated events", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const handler = createReportNudgeEventHandler(
            reportClient("ses_other", prompts),
            stateManager,
            logger,
            baseConfig,
        )

        await handler({ event: { type: "session.idle", properties: {} } } as any)
        assert.equal(prompts.length, 0)
        assert.equal(stateManager.get("ses_other").reportNudgeBucket, undefined)
    })
})
