import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    DEFAULT_REPORT_NUDGE,
    getInvalidConfigKeys,
    mergeReportNudge,
    resolveProtectedTurnsSetting,
} from "../lib/config.ts"

describe("reportNudge configuration", () => {
    it("ships disabled with a 100,000 token interval", () => {
        assert.equal(DEFAULT_REPORT_NUDGE.enabled, false)
        assert.equal(DEFAULT_REPORT_NUDGE.tokenInterval, 100_000)
    })

    it("accepts both documented keys and rejects unknown ones", () => {
        assert.deepEqual(
            getInvalidConfigKeys({ reportNudge: { enabled: true, tokenInterval: 50_000 } }),
            [],
        )
        assert.deepEqual(getInvalidConfigKeys({ reportNudge: { intervalTokens: 50_000 } }), [
            "reportNudge.intervalTokens",
        ])
    })

    it("merges valid overrides and falls back to the base for malformed ones", () => {
        const base = { enabled: false, tokenInterval: 100_000 }

        assert.deepEqual(mergeReportNudge(base, { enabled: true, tokenInterval: 50_000 }), {
            enabled: true,
            tokenInterval: 50_000,
        })
        assert.deepEqual(mergeReportNudge(base, undefined), base)
        assert.deepEqual(mergeReportNudge(base, null as any), base)
        assert.deepEqual(mergeReportNudge(base, [] as any), base)

        // "false" is truthy, so passing it through would switch the feature on.
        assert.deepEqual(mergeReportNudge(base, { enabled: "false" as any }), base)
        assert.deepEqual(mergeReportNudge(base, { tokenInterval: 0 }), base)
        assert.deepEqual(mergeReportNudge(base, { tokenInterval: -5 }), base)
        assert.deepEqual(mergeReportNudge(base, { tokenInterval: Number.NaN }), base)
    })
})

describe("protectedTurns configuration", () => {
    it("defaults to three", () => {
        assert.equal(resolveProtectedTurnsSetting({}), 3)
    })

    it("accepts the legacy nested key as a fallback", () => {
        assert.equal(
            resolveProtectedTurnsSetting({ autoCompression: { protectedTurns: 7 } }),
            7,
        )
    })

    it("prefers the new top-level key when both are present", () => {
        assert.equal(
            resolveProtectedTurnsSetting({
                protectedTurns: 2,
                autoCompression: { protectedTurns: 7 },
            }),
            2,
        )
    })

    it("does not let a lower-priority legacy alias replace an explicit top-level value", () => {
        assert.equal(
            resolveProtectedTurnsSetting(
                { autoCompression: { protectedTurns: 9 } },
                2,
                true,
            ),
            2,
        )
    })
})
