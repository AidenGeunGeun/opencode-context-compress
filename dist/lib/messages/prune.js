import { commitDurableSessionState, saveSessionState } from "../state/index.js";
import { isMessageCompacted } from "../shared-utils.js";
import { findActiveManagementTurn } from "./compress-transform.js";
import { deriveProtectedTailMessageIds } from "./context-map.js";
const PROTECTED_STEPS = 10;
// A media item costs about 1,600 tokens whatever its data-URI length; this is its rough character equivalent.
const MEDIA_CHARS = 6_000;
// A prune may cost up to this multiple of the stale reads paid so far, in exchange for a smaller context.
const REWRITE_TOLERANCE = 1.5;
// Change records, delegated work, plans, and the plugin's own machinery stay verbatim.
export const PROTECTED_TOOLS = new Set([
    "patch",
    "edit",
    "write",
    "subagent",
    "task",
    "skill",
    "todowrite",
    "todoread",
    "question",
    "compress",
    "squash",
    "get_goal",
    "create_goal",
    "update_goal",
]);
/**
 * Background pruning, invisible to the agent: outputs of tool calls older than the newest
 * PROTECTED_STEPS steps since the last fold become a one-line stub, and failed calls lose their
 * string inputs. Marks are durable and only grow, so request bytes stay identical between events
 * and the provider's prompt cache holds.
 *
 * An event prunes every candidate at once, by rent or buy: stale outputs keep being re-read from the
 * cache until those reads reach 1 / REWRITE_TOLERANCE of the cost of the cache rewrite the prune
 * causes. This needs no guess of how long the session will run, and it never prunes on every step.
 * Costs count characters, since the tokenizer ratio cancels out. A cached read costs the model's listed
 * cache read price as a fraction of its input price (0.05 on Opus 5.5 and GPT-6.1), or 0.1 when the host lists
 * none; a cache write costs the input price.
 *
 * A provider can only resume the cache at a marker an earlier request placed. Without one before the
 * first pruned output, the rewrite starts at the end of the system prompt and covers the whole
 * conversation. `anchored` says the request carries a marker just before the prune frontier (see
 * `pruneFrontier`), so the rewrite starts there.
 */
export async function pruneStaleToolOutputs(messages, state, logger, anchored) {
    // A management turn is about to fold the tail, which rewrites it anyway.
    if (findActiveManagementTurn(state, messages))
        return;
    const read = state.modelContext?.cacheReadRatio ?? 0.1;
    const tail = currentTail(messages, state);
    const recent = new Set(deriveProtectedTailMessageIds(tail, PROTECTED_STEPS));
    const candidates = tail.flatMap((message, index) => recent.has(message.info.id)
        ? []
        : message.parts.flatMap((part) => (isPrunable(part, state) ? [{ index, part }] : [])));
    if (candidates.length === 0)
        return;
    const prunedChars = candidates.reduce((total, { part }) => total + prunableChars(part), 0);
    const suffixChars = anchored
        ? tail
            .slice(candidates[0].index)
            .reduce((total, message) => total + messageChars(message, state), 0)
        : state.compressSummaries.reduce((total, block) => total + block.summary.length, 0) +
            messages
                .filter((message) => !isMessageCompacted(state, message))
                .reduce((total, message) => total + messageChars(message, state), 0);
    const stepsAfter = [];
    tail.reduceRight((after, message, index) => {
        stepsAfter[index] = after;
        return after + message.parts.filter((part) => part.type === "step-start").length;
    }, 0);
    // Reads paid so far for each candidate since it aged past the protected steps.
    const rent = candidates.reduce((total, { index, part }) => total + prunableChars(part) * read * (stepsAfter[index] - PROTECTED_STEPS), 0);
    const rewrite = (suffixChars - prunedChars) * (1 - read);
    if (rent * REWRITE_TOLERANCE < rewrite)
        return;
    const candidateState = {
        ...state,
        compressed: {
            ...state.compressed,
            toolIds: new Set([
                ...state.compressed.toolIds,
                ...candidates.map(({ part }) => part.callID),
            ]),
        },
    };
    if (!(await saveSessionState(candidateState, logger))) {
        logger.warn("Pruning skipped because its marks could not be saved", {
            sessionId: state.sessionId,
        });
        return;
    }
    commitDurableSessionState(state, candidateState);
    logger.info("Pruned stale tool outputs", {
        sessionId: state.sessionId,
        tools: candidates.length,
        prunedChars,
        suffixChars,
        rent,
        anchored,
    });
}
/**
 * The oldest tool call a later prune may still change. Everything before it stays byte-identical
 * until the next fold, so a cache marker placed just before its message lets a prune rewrite only
 * what follows.
 */
export function pruneFrontier(messages, state) {
    return currentTail(messages, state)
        .flatMap((message) => message.parts)
        .find((part) => isPrunable(part, state))?.callID;
}
function currentTail(messages, state) {
    return messages.slice(messages.findLastIndex((m) => isMessageCompacted(state, m)) + 1);
}
function isPrunable(part, state) {
    return (part.type === "tool" &&
        !PROTECTED_TOOLS.has(part.tool) &&
        !state.compressed.toolIds.has(part.callID) &&
        (part.state.status === "completed" || part.state.status === "error"));
}
function prunableChars(part) {
    if (part.state.status === "completed")
        return outputChars(part.state.output);
    return Object.values(part.state.input).reduce((total, value) => total + (typeof value === "string" ? value.length : 0), 0);
}
function messageChars(message, state) {
    return message.parts.reduce((total, part) => {
        if (part.type === "text" || part.type === "reasoning")
            return total + part.text.length;
        if (part.type !== "tool")
            return total;
        const output = part.state.status === "completed" && !state.compressed.toolIds.has(part.callID)
            ? outputChars(part.state.output)
            : 0;
        return total + JSON.stringify(part.state.input).length + output;
    }, 0);
}
function outputChars(output) {
    if (typeof output === "string")
        return output.length;
    if (!Array.isArray(output))
        return 0;
    return output.reduce((total, item) => {
        if (item?.type === "text" && typeof item.text === "string")
            return total + item.text.length;
        return total + (item?.type === "file" ? MEDIA_CHARS : 0);
    }, 0);
}
//# sourceMappingURL=prune.js.map