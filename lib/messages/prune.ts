import type { Logger } from "../logger.js"
import type { SessionState, ToolPart, WithParts } from "../state/index.js"
import { commitDurableSessionState, saveSessionState } from "../state/index.js"
import { isMessageCompacted } from "../shared-utils.js"
import { findActiveManagementTurn } from "./compress-transform.js"
import { deriveProtectedTailMessageIds } from "./context-map.js"

const PROTECTED_STEPS = 10
// A media item costs about 1,600 tokens whatever its data-URI length; this is its rough character equivalent.
const MEDIA_CHARS = 6_000
// Change records, delegated work, plans, and the plugin's own machinery stay verbatim.
const PROTECTED_TOOLS = new Set([
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
])

/**
 * Background pruning, invisible to the agent: outputs of tool calls older than the newest
 * PROTECTED_STEPS steps since the last fold become a one-line stub, and failed calls lose their
 * string inputs. Marks are durable and only grow, so request bytes stay identical between events
 * and the provider's prompt cache holds.
 *
 * An event prunes every candidate at once, by rent or buy: stale outputs keep being re-read from the
 * cache until those reads add up to a quarter of the cost of rewriting the cache after them. This
 * needs no guess of how long the session will run, and it never prunes on every step. Costs count
 * characters, since the tokenizer ratio cancels out; a cached read costs 0.1 of an uncached input.
 */
export async function pruneStaleToolOutputs(
    messages: WithParts[],
    state: SessionState,
    logger: Logger,
): Promise<void> {
    // A management turn is about to fold the tail, which rewrites it anyway.
    if (findActiveManagementTurn(state, messages)) return

    const tail = messages.slice(messages.findLastIndex((m) => isMessageCompacted(state, m)) + 1)
    const recent = new Set(deriveProtectedTailMessageIds(tail, PROTECTED_STEPS))
    const candidates = tail.flatMap((message, index) =>
        recent.has(message.info.id)
            ? []
            : message.parts.flatMap((part) =>
                  part.type === "tool" &&
                  !PROTECTED_TOOLS.has(part.tool) &&
                  !state.compressed.toolIds.has(part.callID) &&
                  (part.state.status === "completed" || part.state.status === "error")
                      ? [{ index, part }]
                      : [],
              ),
    )
    if (candidates.length === 0) return

    const prunedChars = candidates.reduce((total, { part }) => total + prunableChars(part), 0)
    const suffixChars = tail
        .slice(candidates[0].index)
        .reduce((total, message) => total + messageChars(message, state), 0)
    const stepsAfter: number[] = []
    tail.reduceRight((after, message, index) => {
        stepsAfter[index] = after
        return after + message.parts.filter((part) => part.type === "step-start").length
    }, 0)
    // Reads paid so far for each candidate since it aged past the protected steps.
    const rent = candidates.reduce(
        (total, { index, part }) =>
            total + prunableChars(part) * 0.1 * (stepsAfter[index] - PROTECTED_STEPS),
        0,
    )
    const rewrite = (suffixChars - prunedChars) * 0.9
    // Weighting rent 4x prunes earlier for a smaller context; a replay of recorded sessions kept
    // average context about 25% lower with net savings in every session.
    if (rent * 4 < rewrite) return

    const candidateState: SessionState = {
        ...state,
        compressed: {
            ...state.compressed,
            toolIds: new Set([
                ...state.compressed.toolIds,
                ...candidates.map(({ part }) => part.callID),
            ]),
        },
    }
    if (!(await saveSessionState(candidateState, logger))) {
        logger.warn("Pruning skipped because its marks could not be saved", {
            sessionId: state.sessionId,
        })
        return
    }
    commitDurableSessionState(state, candidateState)
    logger.info("Pruned stale tool outputs", {
        sessionId: state.sessionId,
        tools: candidates.length,
        prunedChars,
        suffixChars,
        rent,
    })
}

function prunableChars(part: ToolPart): number {
    if (part.state.status === "completed") return outputChars(part.state.output)
    return Object.values(part.state.input).reduce<number>(
        (total, value) => total + (typeof value === "string" ? value.length : 0),
        0,
    )
}

function messageChars(message: WithParts, state: SessionState): number {
    return message.parts.reduce((total, part) => {
        if (part.type === "text" || part.type === "reasoning") return total + part.text.length
        if (part.type !== "tool") return total
        const output =
            part.state.status === "completed" && !state.compressed.toolIds.has(part.callID)
                ? outputChars(part.state.output)
                : 0
        return total + JSON.stringify(part.state.input).length + output
    }, 0)
}

function outputChars(output: unknown): number {
    if (typeof output === "string") return output.length
    if (!Array.isArray(output)) return 0
    return output.reduce<number>((total, item) => {
        if (item?.type === "text" && typeof item.text === "string") return total + item.text.length
        return total + (item?.type === "file" ? MEDIA_CHARS : 0)
    }, 0)
}
