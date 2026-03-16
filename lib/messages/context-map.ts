import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { countTokens } from "../token-utils"
import { transformMessagesForSearch } from "./compress-transform"
import { extractMessageContent } from "../tools/utils"

const ACTIVE_TAIL_COUNT = 4
const PREVIEW_MAX_CHARS = 90

export type ContextMapKey = number | string

export interface ContextMapEntry {
    key: ContextMapKey
    position: number
    kind: "message" | "block"
    role: string
    rawMessageIds: string[]
    preview: string
    tokenEstimate: number
    toolCallCount: number
    toolTypes: string[]
}

export interface ContextMapResult {
    mapText: string
    lookup: Map<number | string, string[]>
    entries: ContextMapEntry[]
    keyOrder: Array<number | string>
    keyToPosition: Map<number | string, number>
}

export interface ResolvedContextMapRange {
    fromKey: ContextMapKey
    toKey: ContextMapKey
    startPosition: number
    endPosition: number
    mapEntryCount: number
    entries: ContextMapEntry[]
    messageIds: string[]
    nonBlockMessageIds: string[]
    blockIds: string[]
}

function dedupeMessageIds(ids: string[]): string[] {
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const id of ids) {
        if (seen.has(id)) {
            continue
        }
        seen.add(id)
        deduped.push(id)
    }
    return deduped
}

function formatRangeLabel(start: number, end: number): string {
    return start === end ? `${start}` : `${start}-${end}`
}

function normalizeInline(text: string): string {
    return text.replace(/\s+/g, " ").trim()
}

function trimPreview(text: string): string {
    if (!text) {
        return "(no text content)"
    }
    const normalized = normalizeInline(text)
    if (normalized.length <= PREVIEW_MAX_CHARS) {
        return normalized
    }
    return normalized.slice(0, PREVIEW_MAX_CHARS - 3) + "..."
}

function extractPrimaryText(msg: WithParts): string {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if ((part.type === "text" || part.type === "reasoning") && typeof (part as any).text === "string") {
            const text = normalizeInline((part as any).text)
            if (text) {
                return text
            }
        }
    }
    return normalizeInline(extractMessageContent(msg))
}

function collectToolStats(msg: WithParts): { count: number; types: string[] } {
    const toolTypes = new Set<string>()
    let count = 0
    const parts = Array.isArray(msg.parts) ? msg.parts : []

    for (const part of parts) {
        if (part.type !== "tool") {
            continue
        }
        count++
        if (part.tool) {
            toolTypes.add(part.tool)
        }
    }

    return {
        count,
        types: [...toolTypes],
    }
}

function buildContextMapEntries(
    rawMessages: WithParts[],
    state: SessionState,
    logger: Logger,
    providerId?: string,
): {
    entries: ContextMapEntry[]
    lookup: Map<number | string, string[]>
    keyOrder: Array<number | string>
    keyToPosition: Map<number | string, number>
} {
    const { transformed, syntheticMap } = transformMessagesForSearch(rawMessages, state, logger)
    const blockIndexByAnchor = new Map(
        state.compressSummaries.map((summary, idx) => [summary.anchorMessageId, idx]),
    )

    const entries: ContextMapEntry[] = []
    const lookup = new Map<number | string, string[]>()
    const keyOrder: Array<number | string> = []
    const keyToPosition = new Map<number | string, number>()

    let messageNumber = 0
    let fallbackBlockIndex = state.compressSummaries.length

    for (const msg of transformed) {
        const summary = syntheticMap.get(msg.info.id)
        if (summary) {
            const configuredBlockIndex = blockIndexByAnchor.get(summary.anchorMessageId)
            const blockId = `b${configuredBlockIndex ?? fallbackBlockIndex++}`
            const rawMessageIds = dedupeMessageIds(
                summary.messageIds.length > 0 ? summary.messageIds : [summary.anchorMessageId],
            )
            const entry: ContextMapEntry = {
                key: blockId,
                position: entries.length,
                kind: "block",
                role: "assistant",
                rawMessageIds,
                preview: trimPreview(summary.summary),
                tokenEstimate: countTokens(summary.summary, providerId),
                toolCallCount: 0,
                toolTypes: [],
            }
            entries.push(entry)
            keyOrder.push(blockId)
            keyToPosition.set(blockId, entry.position)
            lookup.set(blockId, rawMessageIds)
            continue
        }

        messageNumber += 1
        const content = extractMessageContent(msg)
        const toolStats = collectToolStats(msg)
        const entry: ContextMapEntry = {
            key: messageNumber,
            position: entries.length,
            kind: "message",
            role: msg.info.role,
            rawMessageIds: [msg.info.id],
            preview: trimPreview(extractPrimaryText(msg)),
            tokenEstimate: countTokens(content, providerId),
            toolCallCount: toolStats.count,
            toolTypes: toolStats.types,
        }
        entries.push(entry)
        keyOrder.push(messageNumber)
        keyToPosition.set(messageNumber, entry.position)
        lookup.set(messageNumber, [msg.info.id])
    }

    return {
        entries,
        lookup,
        keyOrder,
        keyToPosition,
    }
}

function buildMapText(entries: ContextMapEntry[], lookup: Map<number | string, string[]>): string {
    const lines: string[] = ["<compress-context-map>"]

    let i = 0
    while (i < entries.length) {
        const current = entries[i]

        if (current.kind === "block") {
            lines.push(
                `[${current.key}] [compressed] "${current.preview}" (~${current.tokenEstimate.toLocaleString()} tokens)`,
            )
            i += 1
            continue
        }

        if (current.role === "user") {
            lines.push(`[${current.key}] user: "${current.preview}"`)
            i += 1
            continue
        }

        let end = i
        while (end + 1 < entries.length) {
            const next = entries[end + 1]
            if (next.kind === "block") {
                break
            }
            if (next.role === "user") {
                break
            }
            end += 1
        }

        const grouped = entries.slice(i, end + 1)
        const startKey = grouped[0].key as number
        const endKey = grouped[grouped.length - 1].key as number
        const rangeLabel = formatRangeLabel(startKey, endKey)
        const groupKey = `${rangeLabel}`
        if (grouped.length > 1) {
            const ids = dedupeMessageIds(grouped.flatMap((entry) => entry.rawMessageIds))
            lookup.set(groupKey, ids)
        }

        const toolCallCount = grouped.reduce((sum, entry) => sum + entry.toolCallCount, 0)
        const toolTypes = [...new Set(grouped.flatMap((entry) => entry.toolTypes))]
        const tokenEstimate = grouped.reduce((sum, entry) => sum + entry.tokenEstimate, 0)
        const firstPreview = grouped.find((entry) => entry.preview)?.preview ?? "assistant activity"

        const toolDetails =
            toolCallCount > 0
                ? `${toolCallCount} tool calls (${toolTypes.join(", ")})`
                : `messages grouped for context`

        lines.push(
            `[${rangeLabel}] assistant: ${toolDetails} - ${firstPreview} (~${tokenEstimate.toLocaleString()} tokens)`,
        )

        i = end + 1
    }

    const numericEntries = entries.filter((entry) => entry.kind === "message")
    const blockEntries = entries.filter((entry) => entry.kind === "block")
    const totalTokens = entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0)

    lines.push("---")

    if (numericEntries.length > 0) {
        const activeEntries = numericEntries.slice(-ACTIVE_TAIL_COUNT)
        const start = activeEntries[0].key as number
        const end = activeEntries[activeEntries.length - 1].key as number
        const activeRange = formatRangeLabel(start, end)
        if (activeEntries.length > 1) {
            const ids = dedupeMessageIds(activeEntries.flatMap((entry) => entry.rawMessageIds))
            lookup.set(activeRange, ids)
        }
        lines.push(`Active: [${activeRange}] (current work - do not compress)`)
    }

    lines.push(
        `Total: ${numericEntries.length} messages + ${blockEntries.length} ${blockEntries.length === 1 ? "block" : "blocks"} | ~${totalTokens.toLocaleString()} tokens`,
    )
    lines.push("</compress-context-map>")

    return lines.join("\n")
}

export function buildContextMap(
    rawMessages: WithParts[],
    state: SessionState,
    logger: Logger,
    providerId?: string,
): ContextMapResult {
    const { entries, lookup, keyOrder, keyToPosition } = buildContextMapEntries(rawMessages, state, logger, providerId)
    const mapText = buildMapText(entries, lookup)
    return {
        mapText,
        lookup,
        entries,
        keyOrder,
        keyToPosition,
    }
}

function normalizeRangeBoundary(boundary: number | string): number | string {
    if (typeof boundary === "number") {
        return boundary
    }

    const normalized = boundary.trim()
    if (/^\d+$/.test(normalized)) {
        return Number(normalized)
    }
    if (/^b\d+$/i.test(normalized)) {
        return normalized.toLowerCase()
    }
    return normalized
}

function resolveBoundaryPosition(
    contextMap: ContextMapResult,
    boundary: number | string,
    side: "start" | "end",
): number | undefined {
    const direct = contextMap.keyToPosition.get(boundary)
    if (direct !== undefined) {
        return direct
    }

    if (typeof boundary !== "string") {
        return undefined
    }

    const grouped = boundary.match(/^(\d+)\s*-\s*(\d+)$/)
    if (!grouped) {
        return undefined
    }

    const start = Number(grouped[1])
    const end = Number(grouped[2])
    const target = side === "start" ? start : end
    return contextMap.keyToPosition.get(target)
}

export function resolveContextMapRange(
    contextMap: ContextMapResult,
    from: number | string,
    to: number | string,
): ResolvedContextMapRange {
    const fromKey = normalizeRangeBoundary(from)
    const toKey = normalizeRangeBoundary(to)

    const startPosition = resolveBoundaryPosition(contextMap, fromKey, "start")
    if (startPosition === undefined) {
        throw new Error(
            `Unknown range start: ${String(from)}. Use indexes from <compress-context-map>.`,
        )
    }

    const endPosition = resolveBoundaryPosition(contextMap, toKey, "end")
    if (endPosition === undefined) {
        throw new Error(`Unknown range end: ${String(to)}. Use indexes from <compress-context-map>.`)
    }

    if (startPosition > endPosition) {
        throw new Error(`Range start must appear before end. Received from=${String(from)}, to=${String(to)}.`)
    }

    const entries = contextMap.entries.slice(startPosition, endPosition + 1)
    const blockEntries = entries.filter((entry) => entry.kind === "block")
    const messageEntries = entries.filter((entry) => entry.kind === "message")
    const messageIds = dedupeMessageIds(entries.flatMap((entry) => entry.rawMessageIds))
    const nonBlockMessageIds = dedupeMessageIds(messageEntries.flatMap((entry) => entry.rawMessageIds))
    const blockIds = blockEntries.map((entry) => String(entry.key))

    return {
        fromKey,
        toKey,
        startPosition,
        endPosition,
        mapEntryCount: entries.length,
        entries,
        messageIds,
        nonBlockMessageIds,
        blockIds,
    }
}
