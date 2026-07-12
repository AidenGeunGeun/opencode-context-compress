import { countTokens, estimateTokensBatch } from "../token-utils.js";
import { transformMessagesForSearch, findActiveManagementTurn } from "./compress-transform.js";
import { collectContentInRange, extractMessageContent } from "../tools/utils.js";
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
/**
 * Extract a human-readable preview for a compressed block.
 * Uses the stored topic if available; otherwise strips known
 * preservation markers before generating a content preview.
 */
function extractBlockPreview(summary) {
    if (summary.topic) {
        return summary.topic;
    }
    const cleaned = summary.summary
        .replace(/^\[Preserved from previous compression\]\s*/gm, "")
        .replace(/^\[Preserved context\]\s*/gm, "")
        .replace(/^\[New content\]\s*/gm, "")
        .replace(/^\[Compressed conversation block\]\s*/gm, "")
        .trim();
    return trimPreview(cleaned);
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
    const toolIds = new Set();
    let count = 0;
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
        if (part.type !== "tool") {
            continue;
        }
        count++;
        if (part.callID) {
            toolIds.add(part.callID);
        }
        if (part.tool) {
            toolTypes.add(part.tool);
        }
    }
    return {
        count,
        ids: [...toolIds],
        types: [...toolTypes],
    };
}
function buildBlockIdByAnchor(rawMessages, state) {
    const rawMessageIndexById = new Map(rawMessages.map((message, index) => [message.info.id, index]));
    const sortedSummaries = state.compressSummaries
        .map((summary, originalIndex) => ({
        summary,
        originalIndex,
        anchorPosition: rawMessageIndexById.get(summary.anchorMessageId) ?? Number.MAX_SAFE_INTEGER,
    }))
        .sort((a, b) => {
        if (a.anchorPosition !== b.anchorPosition) {
            return a.anchorPosition - b.anchorPosition;
        }
        return a.originalIndex - b.originalIndex;
    });
    return new Map(sortedSummaries.map(({ summary }, index) => [summary.anchorMessageId, `b${index}`]));
}
function buildContextMapEntries(rawMessages, state, logger, providerId) {
    const { transformed: transformedMessages, syntheticMap } = transformMessagesForSearch(rawMessages, state, logger);
    // The active management turn's own trigger message (the management reminder) is
    // not yet suppressed by the transform above - a still-open turn's own tail stays fully
    // visible in the transcript by design. But it is never a meaningful selectable entry for
    // range compression, so exclude it from the map specifically while the turn is open.
    const activeTurn = findActiveManagementTurn(state, rawMessages);
    const transformed = activeTurn
        ? transformedMessages.filter((msg) => msg.info.id !== activeTurn.turn.triggerMessageId)
        : transformedMessages;
    const blockIdByAnchor = buildBlockIdByAnchor(rawMessages, state);
    const entries = [];
    const lookup = new Map();
    const keyOrder = [];
    const keyToPosition = new Map();
    let messageNumber = 0;
    let fallbackBlockIndex = blockIdByAnchor.size;
    for (const msg of transformed) {
        const summary = syntheticMap.get(msg.info.id);
        if (summary) {
            const blockId = blockIdByAnchor.get(summary.anchorMessageId) ?? `b${fallbackBlockIndex++}`;
            const rawMessageIds = dedupeMessageIds(summary.messageIds.length > 0 ? summary.messageIds : [summary.anchorMessageId]);
            const entry = {
                key: blockId,
                position: entries.length,
                kind: "block",
                role: "assistant",
                rawMessageIds,
                anchorMessageId: summary.anchorMessageId,
                preview: extractBlockPreview(summary),
                tokenEstimate: countTokens(summary.summary, providerId),
                compressionTokenEstimate: countTokens(summary.summary, providerId),
                toolCallCount: 0,
                toolIds: [],
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
            compressionTokenEstimate: estimateTokensBatch(collectContentInRange([msg], 0, 0), providerId),
            toolCallCount: toolStats.count,
            toolIds: toolStats.ids,
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
function countStepStarts(entry, messageById) {
    return entry.rawMessageIds.reduce((count, messageId) => {
        const message = messageById.get(messageId);
        if (!message || !Array.isArray(message.parts))
            return count;
        return count + message.parts.filter((part) => part.type === "step-start").length;
    }, 0);
}
function deriveProtectedTailMessageIds(entries, rawMessages, protectedTurns) {
    if (protectedTurns <= 0)
        return [];
    const messagePositions = entries
        .map((entry, position) => ({ entry, position }))
        .filter(({ entry }) => entry.kind === "message");
    if (messagePositions.length === 0)
        return [];
    const messageById = new Map(rawMessages.map((message) => [message.info.id, message]));
    let protectedStart = messagePositions[0].position;
    let turnCount = 0;
    for (let i = messagePositions.length - 1; i >= 0; i--) {
        const current = messagePositions[i];
        protectedStart = current.position;
        turnCount += countStepStarts(current.entry, messageById);
        if (turnCount >= protectedTurns)
            break;
    }
    // Synthetic test histories and imported sessions can lack step-start parts. In that
    // case, treating the last N visible messages as the tail is the least surprising
    // approximation and still leaves older context selectable.
    if (turnCount === 0) {
        protectedStart = messagePositions[Math.max(0, messagePositions.length - protectedTurns)].position;
    }
    return dedupeMessageIds(entries
        .slice(protectedStart)
        .filter((entry) => entry.kind === "message")
        .flatMap((entry) => entry.rawMessageIds));
}
export function deriveAutomaticProtectedTail(rawMessages, state, logger, protectedTurns) {
    const { transformed, syntheticMap } = transformMessagesForSearch(rawMessages, state, logger);
    const visibleMessages = transformed.filter((message) => !syntheticMap.has(message.info.id));
    if (visibleMessages.length === 0) {
        return { protectedMessageIds: [], hasSelectableMessages: false };
    }
    let protectedStart = visibleMessages.length;
    let turnCount = 0;
    for (let index = visibleMessages.length - 1; index >= 0; index--) {
        protectedStart = index;
        const parts = Array.isArray(visibleMessages[index].parts) ? visibleMessages[index].parts : [];
        turnCount += parts.filter((part) => part.type === "step-start").length;
        if (turnCount >= protectedTurns)
            break;
    }
    if (protectedTurns <= 0)
        protectedStart = visibleMessages.length;
    if (protectedTurns > 0 && turnCount === 0) {
        protectedStart = Math.max(0, visibleMessages.length - protectedTurns);
    }
    return {
        protectedMessageIds: visibleMessages.slice(protectedStart).map((message) => message.info.id),
        hasSelectableMessages: protectedStart > 0,
    };
}
function markProtectedEntries(entries, protectedMessageIds) {
    const protectedIds = new Set(protectedMessageIds);
    for (const entry of entries) {
        entry.protected = entry.rawMessageIds.some((messageId) => protectedIds.has(messageId));
    }
}
function buildMapText(entries, lookup) {
    const lines = ["<compress-context-map>"];
    let i = 0;
    while (i < entries.length) {
        const current = entries[i];
        if (current.kind === "block") {
            const protection = current.protected ? " [protected active tail]" : "";
            lines.push(`[${current.key}]${protection} [compressed] "${current.preview}" (~${current.tokenEstimate.toLocaleString()} tokens)`);
            i += 1;
            continue;
        }
        if (current.role === "user") {
            const protection = current.protected ? " [protected active tail]" : "";
            lines.push(`[${current.key}]${protection} user: "${current.preview}"`);
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
            if (next.protected !== current.protected) {
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
        const tokenEstimate = grouped.reduce((sum, entry) => sum + entry.tokenEstimate, 0);
        const firstPreview = grouped.find((entry) => entry.preview)?.preview ?? "assistant activity";
        const toolDetails = toolCallCount > 0 ? `${toolCallCount} tool calls` : `messages grouped for context`;
        const protection = current.protected ? " [protected active tail]" : "";
        lines.push(`[${rangeLabel}]${protection} assistant: ${toolDetails} - ${firstPreview} (~${tokenEstimate.toLocaleString()} tokens)`);
        i = end + 1;
    }
    const numericEntries = entries.filter((entry) => entry.kind === "message");
    const blockEntries = entries.filter((entry) => entry.kind === "block");
    const totalTokens = entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0);
    lines.push("---");
    lines.push(`Total: ${numericEntries.length} messages + ${blockEntries.length} ${blockEntries.length === 1 ? "block" : "blocks"} | ~${totalTokens.toLocaleString()} tokens`);
    const protectedCount = numericEntries.filter((entry) => entry.protected).length;
    if (protectedCount > 0) {
        lines.push(`Protected active tail: ${protectedCount} messages`);
    }
    lines.push("</compress-context-map>");
    return lines.join("\n");
}
export function buildContextMap(rawMessages, state, logger, providerId, options) {
    const { entries, lookup, keyOrder, keyToPosition } = buildContextMapEntries(rawMessages, state, logger, providerId);
    const activeTurn = findActiveManagementTurn(state, rawMessages);
    const protectedMessageIds = options?.protectedMessageIds ??
        activeTurn?.turn.protectedMessageIds ??
        deriveProtectedTailMessageIds(entries, rawMessages, options?.protectedTurns ?? 0);
    markProtectedEntries(entries, protectedMessageIds);
    const mapText = buildMapText(entries, lookup);
    return {
        mapText,
        lookup,
        entries,
        keyOrder,
        keyToPosition,
        protectedMessageIds,
    };
}
export function createCompressionMapSnapshot(triggerMessageId, contextMap) {
    return {
        triggerMessageId,
        entries: contextMap.entries.map((entry) => ({
            key: entry.key,
            kind: entry.kind,
            rawMessageIds: [...entry.rawMessageIds],
            ...(entry.anchorMessageId ? { anchorMessageId: entry.anchorMessageId } : {}),
            ...(entry.protected ? { protected: true } : {}),
            toolIds: [...entry.toolIds],
            tokenEstimate: entry.compressionTokenEstimate,
        })),
    };
}
export function contextMapFromCompressionSnapshot(snapshot) {
    const entries = snapshot.entries.map((entry, position) => ({
        key: entry.key,
        position,
        kind: entry.kind,
        role: "",
        rawMessageIds: [...entry.rawMessageIds],
        ...(entry.anchorMessageId ? { anchorMessageId: entry.anchorMessageId } : {}),
        preview: "",
        tokenEstimate: entry.tokenEstimate,
        compressionTokenEstimate: entry.tokenEstimate,
        toolCallCount: entry.toolIds.length,
        toolIds: [...entry.toolIds],
        toolTypes: [],
        ...(entry.protected ? { protected: true } : {}),
    }));
    const keyToPosition = new Map();
    const lookup = new Map();
    entries.forEach((entry, position) => {
        keyToPosition.set(entry.key, position);
        lookup.set(entry.key, [...entry.rawMessageIds]);
    });
    return {
        mapText: "",
        lookup,
        entries,
        keyOrder: entries.map((entry) => entry.key),
        keyToPosition,
        protectedMessageIds: entries
            .filter((entry) => entry.protected)
            .flatMap((entry) => entry.rawMessageIds),
    };
}
function describeAvailableBoundaries(contextMap) {
    const numeric = contextMap.entries
        .filter((entry) => typeof entry.key === "number")
        .map((entry) => entry.key);
    const blocks = contextMap.entries
        .filter((entry) => typeof entry.key === "string")
        .map((entry) => `[${entry.key}]`);
    const numericDescription = numeric.length === 0
        ? "no numeric entries"
        : numeric.length === 1
            ? `numeric boundary ${numeric[0]}`
            : `numeric boundaries ${numeric[0]} through ${numeric[numeric.length - 1]}`;
    const blockDescription = blocks.length > 0 ? `; block labels ${blocks.join(", ")}` : "";
    return `${numericDescription}${blockDescription}`;
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
        throw new Error(`Unknown range start: ${String(from)}. Nothing was compressed. Do not guess a smaller or differently formatted range; call compress_map and use labels from the map it returns. Available: ${describeAvailableBoundaries(contextMap)}.`);
    }
    const endPosition = resolveBoundaryPosition(contextMap, toKey, "end");
    if (endPosition === undefined) {
        throw new Error(`Unknown range end: ${String(to)}. Nothing was compressed. Do not guess a smaller or differently formatted range; call compress_map and use labels from the map it returns. Available: ${describeAvailableBoundaries(contextMap)}.`);
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