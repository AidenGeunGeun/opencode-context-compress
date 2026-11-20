import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { transformV2Messages } from "../lib/messages/v2-transform.ts"
import { createSessionState } from "../lib/state/state.ts"
import type { Part, WithParts } from "../lib/state/types.ts"

const userMessage = (id: string, parts: Part[]): WithParts => ({
    info: { id, sessionID: "session", role: "user", time: { created: 0 } },
    parts,
})

describe("model-visible user history", () => {
    for (const [name, parts, retained] of [
        ["empty", [], false],
        ["ignored", [{ type: "text", text: "hidden", ignored: true }], false],
        ["normal", [{ type: "text", text: "visible" }], true],
        [
            "mixed",
            [
                { type: "text", text: "hidden", ignored: true },
                { type: "text", text: "visible" },
            ],
            true,
        ],
    ] satisfies Array<[string, Part[], boolean]>) {
        it(`keeps only model-visible user messages: ${name}`, () => {
            const model = [
                { id: "user", role: "user", content: [{ type: "text", text: "visible" }] },
            ]
            assert.deepEqual(
                transformV2Messages([userMessage("user", parts)], createSessionState(), model),
                retained ? model : [],
            )
        })
    }
})
