import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { countTokens, countToolTokens, estimateTokensBatch, isAnthropicProvider } from "../lib/token-utils.ts"

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
        const text = "function calculateTokens(text: string): number { return Math.ceil(text.length / 4); }"
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

describe("estimateTokensBatch", () => {
    it("returns 0 for empty array", () => {
        assert.equal(estimateTokensBatch([]), 0)
    })

    it("returns a positive value for non-empty batch", () => {
        assert.ok(estimateTokensBatch(["hello", "world"]) > 0)
    })

    it("passes provider through to countTokens", () => {
        const texts = ["function foo() { return 42; }", "const bar = 'baz';"]
        const anthropicCount = estimateTokensBatch(texts, "anthropic")
        const defaultCount = estimateTokensBatch(texts)
        assert.ok(anthropicCount > 0)
        assert.ok(defaultCount > 0)
        // Anthropic and tiktoken should produce different counts for code
        assert.notEqual(anthropicCount, defaultCount)
    })
})

describe("countToolTokens", () => {
    it("returns positive value when tool has completed output", () => {
        const part = {
            tool: "read",
            state: { status: "completed", output: "file contents" },
        }

        assert.ok(countToolTokens(part) > 0)
    })

    it("returns 0 when tool part has no extractable content", () => {
        const part = {
            tool: "read",
            state: {},
        }

        assert.equal(countToolTokens(part), 0)
    })
})
