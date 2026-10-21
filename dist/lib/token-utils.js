import { getLastUserMessage } from "./shared-utils.js";
import { countTokens as anthropicCountTokens } from "@anthropic-ai/tokenizer";
import { encodingForModel } from "js-tiktoken";
// Lazy-initialized tiktoken encoder (created on first non-Anthropic call)
let _tiktokenEncoder = null;
function getTiktokenEncoder() {
    if (!_tiktokenEncoder) {
        _tiktokenEncoder = encodingForModel("gpt-4o");
    }
    return _tiktokenEncoder;
}
export function isAnthropicProvider(providerId) {
    if (!providerId)
        return false;
    return providerId.toLowerCase().includes("anthropic");
}
export function getCurrentProviderId(state, messages) {
    return getLastUserMessage(messages)?.info.model?.providerID ?? state.modelContext?.providerId;
}
export function countTokens(text, providerId) {
    if (!text)
        return 0;
    try {
        if (isAnthropicProvider(providerId)) {
            return anthropicCountTokens(text);
        }
        return getTiktokenEncoder().encode(text).length;
    }
    catch {
        // Fallback to heuristic if tokenizers fail
        return Math.ceil(text.length / 4);
    }
}
export function estimateTokensBatch(texts, providerId) {
    if (texts.length === 0)
        return 0;
    return countTokens(texts.join(" "), providerId);
}
//# sourceMappingURL=token-utils.js.map