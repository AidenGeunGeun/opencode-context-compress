import type { WithParts } from "../state/index.js"
import { isIgnoredUserMessage } from "./utils.js"

/**
 * Content-signature based detection of plugin-owned management residue, independent of
 * persisted `state.managementTurns`. This repairs sessions where the persisted trigger is
 * wrong, missing, or incomplete (e.g. an anchor pointing at a mid-turn ignored status
 * notification instead of the actual manage prompt), by recognizing the plugin's own
 * artifacts directly from message content.
 *
 * Matching is intentionally conservative: a suppressible span must start at a "strong"
 * signature (the rendered manage system-reminder) that this plugin alone produces. Compression
 * tools are also valid during normal work, so their presence must never seed a management span.
 * Weaker signals (compression-only user requests, plugin status, tool calls, assistant chatter) are
 * only absorbed when adjacent to a strong signature - never as a standalone trigger - so
 * ordinary conversation that merely mentions "compress" is never touched. A span is only
 * suppressed once it is bounded by a following real (non-artifact) message; an unbounded
 * span reaching the end of history is the active in-flight turn and is left untouched.
 */

const MANAGE_PROMPT_SIGNATURE = /compress manage/i
const CONTEXT_MANAGEMENT_MARKER = /CONTEXT MANAGEMENT REQUESTED/
const STATUS_NOTIFICATION_HEADER = /▣ Context Compress \|/
const STATUS_NOTIFICATION_PROGRESS = /▣ Compressing/
const COMPRESSION_ONLY_REQUEST =
    /^(?:(?:please|pls|kindly|can you|could you|would you|now|thanks|thank you|context|conversation|history|manage|management|compress|compression|compact|cleanup|clean|up|prune|summari[sz]e|old|older|completed|past|previous|messages|turns|work|range|ranges|blocks?|cache|the|my|this|that|our|session|for|to|and|all|some|a|an|it|do|run|just|again)[\s,.;:!?-]*)+$/i
// Matches the exact `<user-message>...</user-message>` wrapper `handleManageCommand()`
// appends around real residual text on mixed `/compress manage ...text...` invocations, so
// legacy repair can retain that text instead of dropping it with the rest of the reminder.
const EMBEDDED_USER_MESSAGE = /<user-message>\s*([\s\S]*?)\s*<\/user-message>/

function getMessageText(message: WithParts): string {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts
        .filter((part: any) => part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text as string)
        .join("\n")
}

function hasToolPart(message: WithParts, predicate: (tool: string) => boolean): boolean {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some((part: any) => part.type === "tool" && typeof part.tool === "string" && predicate(part.tool))
}

const isCompressToolName = (tool: string): boolean => tool === "compress_map" || tool === "compress"

function isManagePromptMessage(message: WithParts): boolean {
    if (message.info.role !== "user" || isIgnoredUserMessage(message)) {
        return false
    }
    const text = getMessageText(message)
    return MANAGE_PROMPT_SIGNATURE.test(text) && CONTEXT_MANAGEMENT_MARKER.test(text)
}

function extractEmbeddedUserText(message: WithParts): string | undefined {
    const match = EMBEDDED_USER_MESSAGE.exec(getMessageText(message))
    const text = match?.[1]?.trim()
    return text ? text : undefined
}

function isStatusNotificationMessage(message: WithParts): boolean {
    if (message.info.role !== "user" || !isIgnoredUserMessage(message)) {
        return false
    }
    const text = getMessageText(message)
    return STATUS_NOTIFICATION_HEADER.test(text) || STATUS_NOTIFICATION_PROGRESS.test(text)
}

function isCompressionOnlyUserRequest(message: WithParts): boolean {
    if (message.info.role !== "user" || isIgnoredUserMessage(message)) {
        return false
    }
    const text = getMessageText(message).trim()
    if (!text) {
        return false
    }
    return COMPRESSION_ONLY_REQUEST.test(text)
}

function isStrongArtifact(message: WithParts): boolean {
    return isManagePromptMessage(message)
}

function isWeakArtifact(message: WithParts): boolean {
    if (message.info.role === "assistant") {
        return !hasToolPart(message, (tool) => !isCompressToolName(tool))
    }
    if (message.info.role === "user") {
        // Any ignored user message is plugin-generated noise (only `sendIgnoredMessage`
        // sets the `ignored` flag) - safe to absorb regardless of exact text, so a
        // non-`▣`-prefixed ignored message can never be mistaken for a real bounding turn.
        if (isIgnoredUserMessage(message)) {
            return true
        }
        return isCompressionOnlyUserRequest(message)
    }
    return false
}

export interface LegacyResidueSuppressionPlan {
    suppressedMessageIds: Set<string>
    retainedTextByMessageId: Map<string, string>
}

export function buildLegacyResidueSuppressionPlan(rawMessages: WithParts[]): LegacyResidueSuppressionPlan {
    const suppressed = new Set<string>()
    const retainedTextByMessageId = new Map<string, string>()
    let i = 0

    while (i < rawMessages.length) {
        if (isStatusNotificationMessage(rawMessages[i])) {
            // Chat notifications are always plugin-owned, but they can follow a legitimate
            // normal-turn compression. Remove only the notification unless a preceding manage
            // reminder already anchored a broader legacy-management span.
            suppressed.add(rawMessages[i].info.id)
            i++
            continue
        }
        if (!isStrongArtifact(rawMessages[i])) {
            i++
            continue
        }

        // A compression-only user request (e.g. "Compress again") immediately preceding a
        // strong seed is pulled into the span too, per the conservative rule that such a
        // request is only ever treated as an artifact when directly adjacent to a definite
        // one. Plain assistant chatter is deliberately NOT swept backward here: unlike text
        // following a strong seed (already anchored by everything that came before it),
        // text preceding a strong seed is ordinary prior conversation far more often than
        // it is management chatter, and broadly hiding it would risk real product content.
        let start = i
        while (
            start > 0 &&
            !suppressed.has(rawMessages[start - 1].info.id) &&
            isCompressionOnlyUserRequest(rawMessages[start - 1])
        ) {
            start--
        }

        let end = i
        while (end + 1 < rawMessages.length) {
            const candidate = rawMessages[end + 1]
            if (isStrongArtifact(candidate) || isWeakArtifact(candidate)) {
                end++
                continue
            }
            break
        }

        if (end + 1 >= rawMessages.length) {
            // Unbounded tail: this is the active in-flight management turn. Nothing from
            // here to the end of history can be bounded either, so stop scanning.
            break
        }

        for (let k = start; k <= end; k++) {
            const candidate = rawMessages[k]
            const embeddedText = isManagePromptMessage(candidate) ? extractEmbeddedUserText(candidate) : undefined
            if (embeddedText) {
                retainedTextByMessageId.set(candidate.info.id, embeddedText)
                continue
            }
            suppressed.add(candidate.info.id)
        }
        i = end + 1
    }

    return { suppressedMessageIds: suppressed, retainedTextByMessageId }
}
