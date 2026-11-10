import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { countTokens, isAnthropicProvider } from "../lib/token-utils.ts"

describe("isAnthropicProvider", () => {
    it("returns true for anthropic provider ID", () => {
        assert.equal(isAnthropicProvider("anthropic"), true)
    })

    it("returns true for provider ID containing anthropic", () => {
        assert.equal(isAnthropicProvider("Anthropic"), true)
        assert.equal(isAnthropicProvider("anthropic.bedrock"), true)
    })

    it("returns false for non-anthropic providers", () => {
        assert.equal(isAnthropicProvider("openai"), false)
        assert.equal(isAnthropicProvider("google"), false)
    })

    it("returns false for undefined", () => {
        assert.equal(isAnthropicProvider(undefined), false)
    })
})

describe("countTokens", () => {
    it("returns 0 for empty string", () => {
        assert.equal(countTokens(""), 0)
    })

    it("returns a positive token count for text", () => {
        assert.ok(countTokens("hello world") > 0)
    })

    it("returns a positive token count for longer text", () => {
        const longText = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ")
        assert.ok(countTokens(longText) > 0)
    })

    it("uses Anthropic tokenizer when providerId is anthropic", () => {
        const text =
            "function calculateTokens(text: string): number { return Math.ceil(text.length / 4); }"
        const anthropicCount = countTokens(text, "anthropic")
        const defaultCount = countTokens(text)
        // Both should be positive
        assert.ok(anthropicCount > 0)
        assert.ok(defaultCount > 0)
        // They should differ for code (Anthropic vs tiktoken use different BPE merges)
        assert.notEqual(anthropicCount, defaultCount)
    })

    it("uses tiktoken for non-anthropic providers", () => {
        const text = "hello world"
        const openaiCount = countTokens(text, "openai")
        const defaultCount = countTokens(text)
        // Without providerId, tiktoken is the default — should match
        assert.equal(openaiCount, defaultCount)
    })
})
