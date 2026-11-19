import { gunzipSync } from "node:zlib";
import { isRecord } from "./shared-utils.js";
// More sessions than run at once, so an active session keeps its baseline; each holds one request body.
const SESSIONS = 8;
// Parts recorded from the first change on, enough to show what was inserted, removed, or rewritten.
const SHOWN = 3;
/**
 * Anthropic binds each thinking block to the tools, system prompt, and every message before it, and drops that block
 * and all later ones when any of those changed. A primary request should therefore only extend the session's previous
 * one, except at a fold. Every request that does not is logged with the parts around its first change, so a drop can be
 * traced to what changed. A fold is marked, not skipped: the state may record a fold only after its first request.
 */
export function createPrefixWatch(logger, lastCompaction) {
    const previous = new Map();
    return async (event, request) => {
        const body = await readBody(request);
        const parts = [
            JSON.stringify(withoutMarkers(body.tools ?? [])),
            JSON.stringify(withoutMarkers(withoutBilling(body.system))),
            ...body.messages.map((message) => JSON.stringify(withoutMarkers(message))),
        ];
        const fold = lastCompaction(event.sessionID);
        const last = previous.get(event.sessionID);
        // Re-inserting keeps the Map in least-recently-used order, so the oldest session is the first key.
        previous.delete(event.sessionID);
        previous.set(event.sessionID, { fold, parts });
        if (previous.size > SESSIONS)
            previous.delete(previous.keys().next().value);
        if (last === undefined)
            return;
        const index = last.parts.findIndex((part, i) => part !== parts[i]);
        if (index === -1)
            return;
        const at = index === 0 ? "tools" : index === 1 ? "system" : `messages.${index - 2}`;
        const folded = fold !== last.fold;
        await logger.info("Request prefix changed", {
            sessionId: event.sessionID,
            at,
            fold: folded,
            previousParts: last.parts.length,
            parts: parts.length,
        });
        await logger.record("prefix", {
            time: new Date().toISOString(),
            sessionID: event.sessionID,
            model: event.model.id,
            at,
            fold: folded,
            previous: last.parts.slice(index, index + SHOWN).map((part) => JSON.parse(part)),
            current: parts.slice(index, index + SHOWN).map((part) => JSON.parse(part)),
        });
    };
}
// The body is gzipped when anthropic-auth's rewrite ran before this hook.
async function readBody(request) {
    const bytes = Buffer.from(await request.arrayBuffer());
    const text = (request.headers.get("content-encoding") === "gzip" ? gunzipSync(bytes) : bytes).toString("utf8");
    return JSON.parse(text);
}
// Cache markers move every request and are not part of the prompt.
function withoutMarkers(value) {
    if (Array.isArray(value))
        return value.map(withoutMarkers);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, item]) => [key, withoutMarkers(item)]));
}
// anthropic-auth's billing block changes every request; Anthropic does not count it as part of the prompt.
function withoutBilling(system) {
    if (!Array.isArray(system))
        return system;
    return system.filter((block) => !(isRecord(block) && String(block.text).startsWith("x-anthropic-billing-header")));
}
//# sourceMappingURL=prefix-watch.js.map