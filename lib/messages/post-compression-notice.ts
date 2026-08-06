import type { SessionState, WithParts } from "../state/index.js"
import { renderPostCompressionNotice } from "../prompts/index.js"
import { createSyntheticUserMessage } from "./utils.js"

/**
 * True once a part represents work the agent actually produced, as opposed to step
 * bookkeeping, snapshots, or the compression call itself. Anything the agent emits after
 * compressing means it has already resumed, so the notice is no longer due.
 */
function isAgentWorkPart(part: unknown): boolean {
    if (!part || typeof part !== "object") return false
    const value = part as { type?: unknown; text?: unknown; tool?: unknown }
    if (value.type === "tool") return true
    return value.type === "text" && typeof value.text === "string" && value.text.trim().length > 0
}

/**
 * Whether an assistant turn can carry evidence that the agent resumed. A native compaction
 * summary is the host's text rather than the agent's, and a failed turn is deliberately not
 * evidence at all: a request that does not complete must leave the notice due, even when it
 * managed some work first. Losing the notice is the worse failure, and the notice clears
 * again as soon as one turn completes. Same exclusions the post-compression cooldown applies
 * in `lib/auto-policy.ts`.
 */
function isResumableAgentTurn(info: { summary?: unknown; error?: unknown }): boolean {
    return info.summary !== true && !info.error
}

/**
 * Whether the transient post-compression notice is still due for this request.
 *
 * Derived on every transform rather than tracked with a consume-once flag: a request that
 * fails or is rebuilt would clear such a flag and silently lose the notice, while
 * recomputing simply returns the same answer again.
 *
 * Must be evaluated against the RAW messages, before compression transforms run - cleanup
 * can suppress the compressing message itself once a later user message bounds its span.
 * Evaluation is at part granularity because the `compress` call and its same-step siblings
 * share one assistant message.
 */
export function isPostCompressionNoticeDue(
    state: SessionState,
    rawMessages: WithParts[],
): boolean {
    const anchorMessageId = state.compressionCooldownAfterMessageId
    if (!anchorMessageId) return false

    const anchorIndex = rawMessages.findIndex((message) => message.info.id === anchorMessageId)
    if (anchorIndex === -1) return false

    const anchor = rawMessages[anchorIndex]
    if (isResumableAgentTurn(anchor.info)) {
        const anchorParts = anchor.parts ?? []
        let compressPartIndex = -1
        for (let i = anchorParts.length - 1; i >= 0; i--) {
            const part = anchorParts[i] as { type?: unknown; tool?: unknown }
            if (part?.type === "tool" && part.tool === "compress") {
                compressPartIndex = i
                break
            }
        }

        // No compress part on the anchor means the call is no longer inspectable here; treat
        // the whole anchor message as part of the compression rather than as work after it.
        const tailStart = compressPartIndex === -1 ? anchorParts.length : compressPartIndex + 1
        for (let i = tailStart; i < anchorParts.length; i++) {
            if (isAgentWorkPart(anchorParts[i])) return false
        }
    }

    for (let i = anchorIndex + 1; i < rawMessages.length; i++) {
        const message = rawMessages[i]
        if (message.info.role !== "assistant") continue
        if (!isResumableAgentTurn(message.info)) continue
        if ((message.parts ?? []).some(isAgentWorkPart)) return false
    }

    return true
}

/**
 * Appends the notice as the final element. It must run after the compression transforms,
 * which rebuild the array and would otherwise discard it, and it must stay a plain
 * (non-`ignored`) user message or OpenCode strips it before the model sees it.
 */
export function appendPostCompressionNotice(
    messages: WithParts[],
    baseUserMessage: WithParts,
): void {
    messages.push(
        createSyntheticUserMessage(
            baseUserMessage,
            renderPostCompressionNotice(),
            (baseUserMessage.info as { variant?: string }).variant,
        ),
    )
}
