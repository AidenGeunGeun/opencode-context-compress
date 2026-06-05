import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    suppressDefaultCommandExecution,
    supportsCommandCancellation,
} from "../lib/commands/suppress.ts"

describe("command suppression", () => {
    it("uses cancelled output when the host exposes it", () => {
        const output = { parts: [{ type: "text", text: "/compress help" }], cancelled: false }

        suppressDefaultCommandExecution(output)

        assert.equal(output.cancelled, true)
        assert.deepEqual(output.parts, [])
    })

    it("clears the shared parts array in place and cancels without throwing", () => {
        const parts = [{ type: "text", text: "/compress manage" }]
        const output = { parts }

        suppressDefaultCommandExecution(output)

        assert.equal(output.cancelled, true)
        assert.equal(parts.length, 0)
        assert.equal(output.parts.length, 0)
    })

    it("detects cancellation support from the output shape", () => {
        assert.equal(supportsCommandCancellation({ parts: [], cancelled: false }), true)
        assert.equal(supportsCommandCancellation({ parts: [] }), false)
    })
})
