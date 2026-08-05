import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    createReportNudgeEventHandler,
    resolveReportNudge,
} from "../lib/report-nudge.ts"
import { DEFAULT_AUTO_COMPRESSION, DEFAULT_REPORT_NUDGE, type PluginConfig } from "../lib/config.ts"
import { SessionStateManager } from "../lib/state/state.ts"

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

const reportClient = (prompts: string[]) => ({
    session: {
        promptAsync: async (input: any) => {
            prompts.push(input.body?.parts?.[0]?.text ?? input.parts?.[0]?.text ?? "")
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

    it("uses the first usable reading only as the previous-turn baseline", () => {
        const first = resolveReportNudge(0, undefined, 100_000)
        assert.equal(first.bucket, undefined)

        const second = resolveReportNudge(120_000, first.bucket, 100_000)
        assert.equal(second.due, false)
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
        const handler = createReportNudgeEventHandler(reportClient(prompts), stateManager, logger, {
            ...baseConfig,
            reportNudge: { enabled: false, tokenInterval: 100_000 },
        })

        await handler(assistantEvent("m1", sessionId, 500_000))

        assert.equal(prompts.length, 0)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, undefined)
    })

    it("opens one visible async prompt when consecutive turns cross each boundary", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const sessionId = "ses_boundaries"
        const handler = createReportNudgeEventHandler(
            reportClient(prompts),
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

        await handler(assistantEvent("m4", sessionId, 150_000))
        assert.equal(prompts.length, 1)

        await handler(assistantEvent("m5", sessionId, 200_000))
        assert.equal(prompts.length, 2)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 2)
    })

    it("queues only one prompt when a single turn jumps across several boundaries", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const sessionId = "ses_jump"
        const handler = createReportNudgeEventHandler(
            reportClient(prompts),
            stateManager,
            logger,
            baseConfig,
        )

        await handler(assistantEvent("m1", sessionId, 90_000))
        await handler(assistantEvent("m2", sessionId, 310_000))

        assert.equal(prompts.length, 1)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 3)
    })

    it("does not backfill a boundary on the first observation after process restart", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const sessionId = "ses_restart"
        const handler = createReportNudgeEventHandler(
            reportClient(prompts),
            stateManager,
            logger,
            baseConfig,
        )

        await handler(assistantEvent("m1", sessionId, 150_000))

        assert.equal(prompts.length, 0)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 1)
    })

    it("does not retry an aborted or rejected checkpoint inside the same bucket", async () => {
        const stateManager = new SessionStateManager()
        const sessionId = "ses_no_retry"
        let attempts = 0
        const client = {
            session: {
                promptAsync: async () => {
                    attempts++
                    return { error: { name: "MessageAbortedError" } }
                },
            },
        }
        const handler = createReportNudgeEventHandler(client, stateManager, logger, baseConfig)

        await handler(assistantEvent("m1", sessionId, 90_000))
        await handler(assistantEvent("m2", sessionId, 100_000))
        await handler(assistantEvent("m3", sessionId, 110_000))

        assert.equal(attempts, 1)
        assert.equal(stateManager.get(sessionId).reportNudgeBucket, 1)
    })

    it("ignores messages that are not completed assistant work", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const sessionId = "ses_filtered"
        const handler = createReportNudgeEventHandler(
            reportClient(prompts),
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

    it("ignores unrelated events", async () => {
        const stateManager = new SessionStateManager()
        const prompts: string[] = []
        const handler = createReportNudgeEventHandler(
            reportClient(prompts),
            stateManager,
            logger,
            baseConfig,
        )

        await handler({ event: { type: "session.idle", properties: {} } } as any)
        assert.equal(prompts.length, 0)
        assert.equal(stateManager.get("ses_other").reportNudgeBucket, undefined)
    })
})
