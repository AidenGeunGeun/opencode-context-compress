import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    DEFAULT_AUTO_COMPRESSION,
    getInvalidConfigKeys,
    resolveProtectedTurnsSetting,
} from "../lib/config.ts"

describe("automatic compression defaults", () => {
    it("initiates at 330,000 tokens or 90% of the context window", () => {
        assert.equal(DEFAULT_AUTO_COMPRESSION.tokenThreshold, 330_000)
        assert.equal(DEFAULT_AUTO_COMPRESSION.contextWindowRatio, 0.9)
    })

    it("rejects keys outside the documented surface", () => {
        assert.deepEqual(
            getInvalidConfigKeys({
                autoCompression: { tokenThreshold: 200_000 },
                periodicNudge: { enabled: true },
            }),
            ["periodicNudge", "periodicNudge.enabled"],
        )
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
