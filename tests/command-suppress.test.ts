import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    configureCommandSuppression,
    suppressDefaultCommandExecution,
    supportsCommandCancellation,
} from "../lib/commands/suppress.ts"

describe("command suppression", () => {
    it("uses cancelled output when the host exposes it", () => {
        const output = { parts: [{ type: "text", text: "/compress help" }], cancelled: false }

        suppressDefaultCommandExecution(output, "__COMPRESS_HELP_HANDLED__")

        assert.equal(output.cancelled, true)
        assert.deepEqual(output.parts, [])
    })

    it("clears the shared parts array without throwing on stock OpenCode hosts", () => {
        configureCommandSuppression({ legacySentinel: false })
        const parts = [{ type: "text", text: "/compress manage" }]
        const output = { parts }

        suppressDefaultCommandExecution(output, "__COMPRESS_MANAGE_HANDLED__")

        assert.equal(output.cancelled, true)
        assert.equal(parts.length, 0)
        assert.equal(output.parts.length, 0)
    })

    it("throws a handled sentinel only in legacy OCO mode", () => {
        configureCommandSuppression({ legacySentinel: true })
        const output = { parts: [{ type: "text", text: "/compress manage" }] }

        try {
            assert.throws(
                () => suppressDefaultCommandExecution(output, "__COMPRESS_MANAGE_HANDLED__"),
                /__COMPRESS_MANAGE_HANDLED__/,
            )
        } finally {
            configureCommandSuppression({ legacySentinel: false })
        }
    })

    it("detects cancellation support from the output shape", () => {
        assert.equal(supportsCommandCancellation({ parts: [], cancelled: false }), true)
        assert.equal(supportsCommandCancellation({ parts: [] }), false)
    })
})
