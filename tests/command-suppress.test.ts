import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
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

    it("throws a handled sentinel when cancellation is unavailable", () => {
        const output = { parts: [{ type: "text", text: "/compress manage" }] }

        assert.throws(
            () => suppressDefaultCommandExecution(output, "__COMPRESS_MANAGE_HANDLED__"),
            /__COMPRESS_MANAGE_HANDLED__/,
        )
    })

    it("detects cancellation support from the output shape", () => {
        assert.equal(supportsCommandCancellation({ parts: [], cancelled: false }), true)
        assert.equal(supportsCommandCancellation({ parts: [] }), false)
    })
})
