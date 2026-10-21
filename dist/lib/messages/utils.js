import { ulid } from "ulid";
import { createHash } from "node:crypto";
export const COMPRESS_SUMMARY_PREFIX = "[Compressed conversation block]\n\n";
const generateUniqueId = (prefix) => `${prefix}_${ulid()}`;
const generateStableId = (prefix, seed) => `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
export const createSyntheticUserMessage = (baseMessage, content, variant, stableSeed) => {
    const info = baseMessage.info;
    const now = stableSeed ? info.time.created : Date.now();
    const messageId = stableSeed ? generateStableId("msg", stableSeed) : generateUniqueId("msg");
    const partId = stableSeed ? generateStableId("prt", stableSeed) : generateUniqueId("prt");
    return {
        info: {
            id: messageId,
            sessionID: info.sessionID,
            role: "user",
            agent: info.agent,
            model: info.model,
            time: { created: now },
            ...(variant !== undefined && { variant }),
        },
        parts: [
            {
                id: partId,
                sessionID: info.sessionID,
                messageID: messageId,
                type: "text",
                text: content,
            },
        ],
    };
};
export const isIgnoredUserMessage = (message) => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (parts.length === 0) {
        return true;
    }
    for (const part of parts) {
        if (!("ignored" in part) || !part.ignored) {
            return false;
        }
    }
    return true;
};
//# sourceMappingURL=utils.js.map