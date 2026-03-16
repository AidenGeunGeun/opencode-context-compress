import { countTokens } from "../token-utils";
import { transformMessagesForSearch } from "./compress-transform";
import { extractMessageContent } from "../tools/utils";
const ACTIVE_TAIL_COUNT = 4;
const PREVIEW_MAX_CHARS = 90;
function dedupeMessageIds(ids) {
    const seen = new Set();
    const deduped = [];
    for (const id of ids) {
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        deduped.push(id);
    }
    return deduped;
}
function formatRangeLabel(start, end) {
    return start === end ? `${start}` : `${start}-${end}`;
}
function normalizeInline(text) {
    return text.replace(/\s+/g, " ").trim();
}
function trimPreview(text) {
    if (!text) {
        return "(no text content)";
    }
    const normalized = normalizeInline(text);
    if (normalized.length <= PREVIEW_MAX_CHARS) {
        return normalized;
    }
    return normalized.slice(0, PREVIEW_MAX_CHARS - 3) + "...";
}
function extractPrimaryText(msg) {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
        if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
            const text = normalizeInline(part.text);
            if (text) {
                return text;
            }
        }
    }
    return normalizeInline(extractMessageContent(msg));
}
function collectToolStats(msg) {
    const toolTypes = new Set();
    let count = 0;
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
        if (part.type !== "tool") {
            continue;
        }
        count++;
        if (part.tool) {
            toolTypes.add(part.tool);
        }
    }
    return {
        count,
        types: [...toolTypes],
    };
}
function buildContextMapEntries(rawMessages, state, logger, providerId) {
    const { transformed, syntheticMap } = transformMessagesForSearch(rawMessages, state, logger);
    const blockIndexByAnchor = new Map(state.compressSummaries.map((summary, idx) => [summary.anchorMessageId, idx]));
    const entries = [];
    const lookup = new Map();
    const keyOrder = [];
    const keyToPosition = new Map();
    let messageNumber = 0;
    let fallbackBlockIndex = state.compressSummaries.length;
    for (const msg of transformed) {
        const summary = syntheticMap.get(msg.info.id);
        if (summary) {
            const configuredBlockIndex = blockIndexByAnchor.get(summary.anchorMessageId);
            const blockId = `b${configuredBlockIndex ?? fallbackBlockIndex++}`;
            const rawMessageIds = dedupeMessageIds(summary.messageIds.length > 0 ? summary.messageIds : [summary.anchorMessageId]);
            const entry = {
                key: blockId,
                position: entries.length,
                kind: "block",
                role: "assistant",
                rawMessageIds,
                preview: trimPreview(summary.summary),
                tokenEstimate: countTokens(summary.summary, providerId),
                toolCallCount: 0,
                toolTypes: [],
            };
            entries.push(entry);
            keyOrder.push(blockId);
            keyToPosition.set(blockId, entry.position);
            lookup.set(blockId, rawMessageIds);
            continue;
        }
        messageNumber += 1;
        const content = extractMessageContent(msg);
        const toolStats = collectToolStats(msg);
        const entry = {
            key: messageNumber,
            position: entries.length,
            kind: "message",
            role: msg.info.role,
            rawMessageIds: [msg.info.id],
            preview: trimPreview(extractPrimaryText(msg)),
            tokenEstimate: countTokens(content, providerId),
            toolCallCount: toolStats.count,
            toolTypes: toolStats.types,
        };
        entries.push(entry);
        keyOrder.push(messageNumber);
        keyToPosition.set(messageNumber, entry.position);
        lookup.set(messageNumber, [msg.info.id]);
    }
    return {
        entries,
        lookup,
        keyOrder,
        keyToPosition,
    };
}
function buildMapText(entries, lookup) {
    const lines = ["<compress-context-map>"];
    let i = 0;
    while (i < entries.length) {
        const current = entries[i];
        if (current.kind === "block") {
            lines.push(`[${current.key}] [compressed] "${current.preview}" (~${current.tokenEstimate.toLocaleString()} tokens)`);
            i += 1;
            continue;
        }
        if (current.role === "user") {
            lines.push(`[${current.key}] user: "${current.preview}"`);
            i += 1;
            continue;
        }
        let end = i;
        while (end + 1 < entries.length) {
            const next = entries[end + 1];
            if (next.kind === "block") {
                break;
            }
            if (next.role === "user") {
                break;
            }
            end += 1;
        }
        const grouped = entries.slice(i, end + 1);
        const startKey = grouped[0].key;
        const endKey = grouped[grouped.length - 1].key;
        const rangeLabel = formatRangeLabel(startKey, endKey);
        const groupKey = `${rangeLabel}`;
        if (grouped.length > 1) {
            const ids = dedupeMessageIds(grouped.flatMap((entry) => entry.rawMessageIds));
            lookup.set(groupKey, ids);
        }
        const toolCallCount = grouped.reduce((sum, entry) => sum + entry.toolCallCount, 0);
        const toolTypes = [...new Set(grouped.flatMap((entry) => entry.toolTypes))];
        const tokenEstimate = grouped.reduce((sum, entry) => sum + entry.tokenEstimate, 0);
        const firstPreview = grouped.find((entry) => entry.preview)?.preview ?? "assistant activity";
        const toolDetails = toolCallCount > 0
            ? `${toolCallCount} tool calls (${toolTypes.join(", ")})`
            : `messages grouped for context`;
        lines.push(`[${rangeLabel}] assistant: ${toolDetails} - ${firstPreview} (~${tokenEstimate.toLocaleString()} tokens)`);
        i = end + 1;
    }
    const numericEntries = entries.filter((entry) => entry.kind === "message");
    const blockEntries = entries.filter((entry) => entry.kind === "block");
    const totalTokens = entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0);
    lines.push("---");
    if (numericEntries.length > 0) {
        const activeEntries = numericEntries.slice(-ACTIVE_TAIL_COUNT);
        const start = activeEntries[0].key;
        const end = activeEntries[activeEntries.length - 1].key;
        const activeRange = formatRangeLabel(start, end);
        if (activeEntries.length > 1) {
            const ids = dedupeMessageIds(activeEntries.flatMap((entry) => entry.rawMessageIds));
            lookup.set(activeRange, ids);
        }
        lines.push(`Active: [${activeRange}] (current work - do not compress)`);
    }
    lines.push(`Total: ${numericEntries.length} messages + ${blockEntries.length} ${blockEntries.length === 1 ? "block" : "blocks"} | ~${totalTokens.toLocaleString()} tokens`);
    lines.push("</compress-context-map>");
    return lines.join("\n");
}
export function buildContextMap(rawMessages, state, logger, providerId) {
    const { entries, lookup, keyOrder, keyToPosition } = buildContextMapEntries(rawMessages, state, logger, providerId);
    const mapText = buildMapText(entries, lookup);
    return {
        mapText,
        lookup,
        entries,
        keyOrder,
        keyToPosition,
    };
}
function normalizeRangeBoundary(boundary) {
    if (typeof boundary === "number") {
        return boundary;
    }
    const normalized = boundary.trim();
    if (/^\d+$/.test(normalized)) {
        return Number(normalized);
    }
    if (/^b\d+$/i.test(normalized)) {
        return normalized.toLowerCase();
    }
    return normalized;
}
function resolveBoundaryPosition(contextMap, boundary, side) {
    const direct = contextMap.keyToPosition.get(boundary);
    if (direct !== undefined) {
        return direct;
    }
    if (typeof boundary !== "string") {
        return undefined;
    }
    const grouped = boundary.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!grouped) {
        return undefined;
    }
    const start = Number(grouped[1]);
    const end = Number(grouped[2]);
    const target = side === "start" ? start : end;
    return contextMap.keyToPosition.get(target);
}
export function resolveContextMapRange(contextMap, from, to) {
    const fromKey = normalizeRangeBoundary(from);
    const toKey = normalizeRangeBoundary(to);
    const startPosition = resolveBoundaryPosition(contextMap, fromKey, "start");
    if (startPosition === undefined) {
        throw new Error(`Unknown range start: ${String(from)}. Use indexes from <compress-context-map>.`);
    }
    const endPosition = resolveBoundaryPosition(contextMap, toKey, "end");
    if (endPosition === undefined) {
        throw new Error(`Unknown range end: ${String(to)}. Use indexes from <compress-context-map>.`);
    }
    if (startPosition > endPosition) {
        throw new Error(`Range start must appear before end. Received from=${String(from)}, to=${String(to)}.`);
    }
    const entries = contextMap.entries.slice(startPosition, endPosition + 1);
    const blockEntries = entries.filter((entry) => entry.kind === "block");
    const messageEntries = entries.filter((entry) => entry.kind === "message");
    const messageIds = dedupeMessageIds(entries.flatMap((entry) => entry.rawMessageIds));
    const nonBlockMessageIds = dedupeMessageIds(messageEntries.flatMap((entry) => entry.rawMessageIds));
    const blockIds = blockEntries.map((entry) => String(entry.key));
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
    };
}
//# sourceMappingURL=context-map.js.map