import { createHash } from "node:crypto";
import { renderFoldRequest } from "./prompts/index.js";
import { promptSession } from "./sdk/client.js";
import { isRecord } from "./shared-utils.js";
// An ignored request is repeated each time the context grows by this much past the threshold.
const REPEAT_TOKENS = 100_000;
/**
 * Sends the fold request when a step ends at the threshold, and again at every further REPEAT_TOKENS.
 * A fold or prune that shrinks the context lowers the level, which re-arms the request.
 */
export function createFoldRequestHandler(client, stateManager, logger, config, pending, acceptsSession) {
    // Shortcut: in memory only, so a plugin reload sends one extra request to a session above the threshold.
    const levels = new Map();
    return async (input) => {
        const event = isRecord(input) ? input : {};
        const data = isRecord(event.data) ? event.data : {};
        const sessionID = data.sessionID;
        if (event.type !== "session.step.ended" || typeof sessionID !== "string")
            return;
        if (typeof data.assistantMessageID !== "string" || typeof event.created !== "number")
            return;
        if (!config.autoCompression.enabled || config.tools.compress.permission === "deny")
            return;
        // This step called `compress`. A request sent now would arrive after the fold and fold again.
        if (pending.has(sessionID))
            return;
        const tokens = isRecord(data.tokens) ? data.tokens : {};
        const cache = isRecord(tokens.cache) ? tokens.cache : {};
        const contextTokens = [
            tokens.input,
            tokens.output,
            tokens.reasoning,
            cache.read,
            cache.write,
        ].reduce((sum, value) => sum + (typeof value === "number" && value > 0 ? value : 0), 0);
        const tokenThreshold = config.autoCompression.tokenThreshold;
        const contextLimit = stateManager.get(sessionID).modelContext?.contextLimit;
        const ratioThreshold = contextLimit
            ? Math.floor(contextLimit * config.autoCompression.contextWindowRatio)
            : undefined;
        const thresholdTokens = Math.min(ratioThreshold ?? tokenThreshold, tokenThreshold);
        const level = contextTokens < thresholdTokens
            ? 0
            : Math.floor((contextTokens - thresholdTokens) / REPEAT_TOKENS) + 1;
        if (level > (levels.get(sessionID) ?? 0)) {
            if (!(await acceptsSession(sessionID, event)))
                return;
            const session = await client.session.get({ sessionID });
            const number = (value) => value.toLocaleString("en-US");
            const basis = ratioThreshold !== undefined && ratioThreshold <= tokenThreshold
                ? `${Math.round(config.autoCompression.contextWindowRatio * 100)}% of the model-reported context window`
                : "the system-wide absolute token limit";
            await promptSession(client, {
                sessionId: sessionID,
                parts: [
                    {
                        type: "text",
                        text: renderFoldRequest(`Working context reached ~${number(contextTokens)} tokens; the fold threshold is ~${number(thresholdTokens)} tokens (${basis}). The plugin sent this request automatically.`, session.parentID !== undefined),
                    },
                ],
                messageId: generateAutomaticPromptMessageId(sessionID, data.assistantMessageID, event.created),
            });
            logger.info("Fold request sent", {
                sessionId: sessionID,
                contextTokens,
                thresholdTokens,
            });
        }
        if (level === 0)
            levels.delete(sessionID);
        else
            levels.set(sessionID, level);
    };
}
// The host deduplicates prompt admission by ID, including across plugin instances.
function generateAutomaticPromptMessageId(sessionId, triggerId, time) {
    const inverted = ~(BigInt(Math.floor(time)) * 0x1000n);
    const prefix = Array.from({ length: 6 }, (_, index) => Number((inverted >> BigInt(40 - 8 * index)) & 0xffn)
        .toString(16)
        .padStart(2, "0")).join("");
    const identity = JSON.stringify(["automatic-compression", sessionId, triggerId]);
    return `msg_${prefix}${createHash("sha256").update(identity).digest("hex").slice(0, 14)}`;
}
//# sourceMappingURL=fold-request.js.map