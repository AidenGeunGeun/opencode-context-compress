import { getLastUserMessage, isMessageCompacted } from "./shared-utils";
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
export function getCurrentParams(state, messages, logger) {
    const userMsg = getLastUserMessage(messages);
    if (!userMsg) {
        logger.debug("No user message found when determining current params");
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: state.variant,
        };
    }
    const userInfo = userMsg.info;
    const agent = userInfo.agent;
    const providerId = userInfo.model.providerID;
    const modelId = userInfo.model.modelID;
    const variant = state.variant ?? userInfo.variant;
    return { providerId, modelId, agent, variant };
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
export function extractToolContent(part) {
    const contents = [];
    if (part.tool === "question") {
        const questions = part.state?.input?.questions;
        if (questions !== undefined) {
            const content = typeof questions === "string" ? questions : JSON.stringify(questions);
            contents.push(content);
        }
        return contents;
    }
    if (part.tool === "edit" || part.tool === "write") {
        if (part.state?.input) {
            const inputContent = typeof part.state.input === "string"
                ? part.state.input
                : JSON.stringify(part.state.input);
            contents.push(inputContent);
        }
    }
    if (part.state?.status === "completed" && part.state?.output) {
        const content = typeof part.state.output === "string"
            ? part.state.output
            : JSON.stringify(part.state.output);
        contents.push(content);
    }
    else if (part.state?.status === "error" && part.state?.error) {
        const content = typeof part.state.error === "string"
            ? part.state.error
            : JSON.stringify(part.state.error);
        contents.push(content);
    }
    return contents;
}
export function countToolTokens(part, providerId) {
    const contents = extractToolContent(part);
    return estimateTokensBatch(contents, providerId);
}
export const calculateTokensSaved = (state, messages, compressedToolIds, providerId) => {
    try {
        const contents = [];
        for (const msg of messages) {
            if (isMessageCompacted(state, msg)) {
                continue;
            }
            const parts = Array.isArray(msg.parts) ? msg.parts : [];
            for (const part of parts) {
                if (part.type !== "tool" || !compressedToolIds.includes(part.callID)) {
                    continue;
                }
                contents.push(...extractToolContent(part));
            }
        }
        return estimateTokensBatch(contents, providerId);
    }
    catch (error) {
        return 0;
    }
};
//# sourceMappingURL=token-utils.js.map