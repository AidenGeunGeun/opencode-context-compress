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
    // A request still in the inbox. A second one queued behind it would arrive after the fold and fold again.
    const undelivered = new Map();
    return async (input) => {
        const event = isRecord(input) ? input : {};
        const data = isRecord(event.data) ? event.data : {};
        const sessionID = data.sessionID;
        if (typeof sessionID !== "string")
            return;
        if ((event.type === "session.inbox.delivered" ||
            event.type === "session.inbox.cancelled") &&
            data.inboxID === undelivered.get(sessionID))
            undelivered.delete(sessionID);
        if (event.type !== "session.step.ended")
            return;
        if (typeof data.assistantMessageID !== "string" || typeof event.created !== "number")
            return;
        if (!config.autoCompression.enabled || config.tools.compress.permission === "deny")
            return;
        if (stateManager.get(sessionID).foldOff)
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
        const threshold = foldThreshold(config, stateManager.get(sessionID));
        const thresholdTokens = threshold.tokens;
        const level = contextTokens < thresholdTokens
            ? 0
            : Math.floor((contextTokens - thresholdTokens) / REPEAT_TOKENS) + 1;
        if (level > (levels.get(sessionID) ?? 0) && !undelivered.has(sessionID)) {
            if (!(await acceptsSession(sessionID, event)))
                return;
            const session = await client.session.get({ sessionID });
            // A subagent's turn-ending message is what its parent receives; a fold now would replace it.
            if (session.parentID !== undefined && data.finish === "stop")
                return;
            const messageId = generateAutomaticPromptMessageId(sessionID, data.assistantMessageID, event.created);
            const number = (value) => value.toLocaleString("en-US");
            await promptSession(client, {
                sessionId: sessionID,
                parts: [
                    {
                        type: "text",
                        text: renderFoldRequest(`Working context reached ~${number(contextTokens)} tokens; the fold threshold is ~${number(thresholdTokens)} tokens (${threshold.basis}). The plugin sent this request automatically.`, session.parentID !== undefined),
                    },
                ],
                messageId,
            });
            undelivered.set(sessionID, messageId);
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
/** Where the first fold request goes out: the token limit or the context window share, whichever is lower. */
export function foldThreshold(config, state) {
    const tokenThreshold = state.tokenThreshold ?? config.autoCompression.tokenThreshold;
    const contextLimit = state.modelContext?.contextLimit;
    const ratioThreshold = contextLimit
        ? Math.floor(contextLimit * config.autoCompression.contextWindowRatio)
        : undefined;
    if (ratioThreshold !== undefined && ratioThreshold <= tokenThreshold)
        return {
            tokens: ratioThreshold,
            basis: `${Math.round(config.autoCompression.contextWindowRatio * 100)}% of the model-reported context window`,
        };
    return {
        tokens: tokenThreshold,
        basis: state.tokenThreshold === undefined
            ? "the system-wide absolute token limit"
            : "this session's token limit",
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