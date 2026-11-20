import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { countTokens } from "../lib/token-utils.ts"

describe("countTokens", () => {
    it("returns 0 for empty string", () => {
        assert.equal(countTokens(""), 0)
    })

    it("counts ordinary text rather than returning a positive placeholder", () => {
        assert.equal(countTokens("hello world"), 2)
    })

    for (const [provider, expected] of [
        ["anthropic", 14],
        ["Anthropic", 14],
        ["anthropic.bedrock", 14],
        ["openai", 13],
        ["google", 13],
        [undefined, 13],
    ] as const) {
        it(`uses the required tokenizer for ${provider ?? "the default provider"}`, () => {
            // Golden counts from Anthropic's tokenizer and OpenAI's o200k_base vocabulary.
            assert.equal(countTokens("function add(a, b) { return a + b; }", provider), expected)
        })
    }
})
