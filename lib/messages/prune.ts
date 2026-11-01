import type { Logger } from "../logger.js"
import type { SessionState, ToolPart, WithParts } from "../state/index.js"
import { commitDurableSessionState, saveSessionState } from "../state/index.js"
import { isMessageCompacted } from "../shared-utils.js"
import { findActiveManagementTurn } from "./compress-transform.js"
import { deriveProtectedTailMessageIds } from "./context-map.js"

const PROTECTED_STEPS = 10
const CACHE_TTL_MS = 5 * 60 * 1000
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
 * An event prunes every candidate at once. It fires when the cache is cold anyway, or when the
 * cached reads it saves over the expected remaining steps outweigh rewriting the cached suffix.
 * Both sides are measured in characters, since the tokenizer ratio cancels out.
 */
export async function pruneStaleToolOutputs(
    messages: WithParts[],
    state: SessionState,
    logger: Logger,
    providerId: string | undefined,
    now = Date.now(),
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
    const stepsSinceFold = tail.reduce(
        (total, message) =>
            total + message.parts.filter((part) => part.type === "step-start").length,
        0,
    )
    const cold = coldCacheReason(messages, now)
    const writePrice = providerId?.toLowerCase().includes("anthropic") ? 1.25 : 1
    // Expected remaining steps are half the steps since the last fold. A replay of recorded sessions
    // showed the full count overestimates the horizon and prunes too often to pay back.
    const savings = prunedChars * 0.1 * (stepsSinceFold / 2)
    const rewrite = (suffixChars - prunedChars) * (writePrice - 0.1)
    if (!cold && savings < rewrite) return

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
        stepsSinceFold,
        cold: cold ?? "no",
    })
}

function coldCacheReason(messages: WithParts[], now: number) {
    const previous = messages.findLast(
        (message) => message.info.role === "assistant" && message.info.time.completed,
    )
    if (!previous?.info.time.completed) return "no completed step"
    if (now - previous.info.time.completed > CACHE_TTL_MS) return "idle past cache TTL"
    if (
        previous.parts.some(
            (part) =>
                part.type === "tool" &&
                (part.tool === "compress" || part.tool === "squash") &&
                part.state.status === "completed",
        )
    ) {
        return "previous step rewrote the blocks"
    }
    return undefined
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
