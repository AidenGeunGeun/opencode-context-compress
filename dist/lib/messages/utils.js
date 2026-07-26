import { ulid } from "ulid";
import { createHash } from "crypto";
export const COMPRESS_SUMMARY_PREFIX = "[Compressed conversation block]\n\n";
const generateUniqueId = (prefix) => `${prefix}_${ulid()}`;
const generateStableId = (prefix, seed) => `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
const isGeminiModel = (modelID) => {
    const lowerModelID = modelID.toLowerCase();
    return lowerModelID.includes("gemini");
};
export const createSyntheticUserMessage = (baseMessage, content, variant, stableSeed) => {
    const userInfo = baseMessage.info;
    const now = stableSeed ? userInfo.time.created : Date.now();
    const messageId = stableSeed ? generateStableId("msg", stableSeed) : generateUniqueId("msg");
    const partId = stableSeed ? generateStableId("prt", stableSeed) : generateUniqueId("prt");
    return {
        info: {
            id: messageId,
            sessionID: userInfo.sessionID,
            role: "user",
            agent: userInfo.agent,
            model: userInfo.model,
            time: { created: now },
            ...(variant !== undefined && { variant }),
        },
        parts: [
            {
                id: partId,
                sessionID: userInfo.sessionID,
                messageID: messageId,
                type: "text",
                text: content,
            },
        ],
    };
};
export const createSyntheticTextPart = (baseMessage, content) => {
    const userInfo = baseMessage.info;
    const partId = generateUniqueId("prt");
    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "text",
        text: content,
    };
};
export const createSyntheticToolPart = (baseMessage, content, modelID) => {
    const userInfo = baseMessage.info;
    const now = Date.now();
    const partId = generateUniqueId("prt");
    const callId = generateUniqueId("call");
    // Gemini requires thoughtSignature bypass to accept synthetic tool parts
    const toolPartMetadata = isGeminiModel(modelID)
        ? { google: { thoughtSignature: "skip_thought_signature_validator" } }
        : {};
    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "tool",
        callID: callId,
        tool: "context_info",
        state: {
            status: "completed",
            input: {},
            output: content,
            title: "Context Info",
            metadata: toolPartMetadata,
            time: { start: now, end: now },
        },
    };
};
export const isIgnoredUserMessage = (message) => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (parts.length === 0) {
        return true;
    }
    for (const part of parts) {
        if (!part.ignored) {
            return false;
        }
    }
    return true;
};
export const findMessageIndex = (messages, messageId) => {
    return messages.findIndex((msg) => msg.info.id === messageId);
};
//# sourceMappingURL=utils.js.map