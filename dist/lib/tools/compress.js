import { tool } from "@opencode-ai/plugin/tool";
import { ensureSessionInitialized } from "../state/index.js";
import { saveSessionState } from "../state/persistence.js";
import { loadPrompt } from "../prompts/index.js";
import { estimateTokensBatch, getCurrentParams } from "../token-utils.js";
import { collectContentInRange, collectToolIdsInRange, } from "./utils.js";
import { sendCompressNotification } from "../ui/notification.js";
import { buildContextMap, resolveContextMapRange, } from "../messages/context-map.js";
import { findActiveManagementTurn } from "../messages/compress-transform.js";
import { listSessionMessages } from "../sdk/client.js";
const COMPRESS_TOOL_DESCRIPTION = loadPrompt("compress-tool-spec");
export function removeSubsumedCompressSummaries(summaries, containedMessageIds) {
    const containedIds = new Set(containedMessageIds);
    return summaries.filter((summary) => {
        if (containedIds.has(summary.anchorMessageId)) {
            return false;
        }
        const summaryMessageIds = Array.isArray(summary.messageIds) ? summary.messageIds : [];
        return !summaryMessageIds.some((messageId) => containedIds.has(messageId));
    });
}
/**
 * Strip recursive preservation/section markers from a summary to prevent
 * nested "[Preserved from previous compression] [Preserved from ..." chains
 * when blocks are re-compressed multiple times.
 */
function stripPreservationMarkers(text) {
    return text
        .replace(/^\[Preserved from previous compression\]\s*/gm, "")
        .replace(/^\[Preserved context\]\s*/gm, "")
        .replace(/^\[New content\]\s*/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
export function composeSummaryWithPreservedBlocks(preservedSummaries, newSummary) {
    if (preservedSummaries.length === 0) {
        return newSummary.trim();
    }
    const cleaned = preservedSummaries
        .map(stripPreservationMarkers)
        .filter(Boolean);
    if (cleaned.length === 0) {
        return newSummary.trim();
    }
    return [
        "[Preserved context]",
        ...cleaned,
        "",
        "[New content]",
        newSummary.trim(),
    ].join("\n");
}
export function calculateCompressionRangeMetrics(rawMessages, rawMessageIndexById, resolvedRange, providerId) {
    const nonBlockMessageIdsSet = new Set(resolvedRange.nonBlockMessageIds);
    const nonBlockRawMessages = rawMessages
        .filter((msg) => nonBlockMessageIdsSet.has(msg.info.id))
        .sort((a, b) => (rawMessageIndexById.get(a.info.id) ?? Number.MAX_SAFE_INTEGER) -
        (rawMessageIndexById.get(b.info.id) ?? Number.MAX_SAFE_INTEGER));
    const toolIds = nonBlockRawMessages.length > 0
        ? collectToolIdsInRange(nonBlockRawMessages, 0, nonBlockRawMessages.length - 1)
        : [];
    const nonBlockTokenEstimate = nonBlockRawMessages.length > 0
        ? estimateTokensBatch(collectContentInRange(nonBlockRawMessages, 0, nonBlockRawMessages.length - 1), providerId)
        : 0;
    const blockTokenEstimate = resolvedRange.entries
        .filter((entry) => entry.kind === "block")
        .reduce((sum, entry) => sum + entry.tokenEstimate, 0);
    return {
        messageIds: resolvedRange.messageIds,
        nonBlockMessageIds: resolvedRange.nonBlockMessageIds,
        mapEntryCount: resolvedRange.mapEntryCount,
        toolIds,
        blockTokenEstimate,
        nonBlockTokenEstimate,
        estimatedCompressedTokens: blockTokenEstimate + nonBlockTokenEstimate,
        incrementalCompressTokens: nonBlockTokenEstimate,
    };
}
/**
 * Select the final stored summary for a compression range.
 *
 * If the range contains only existing compressed blocks and no new raw messages
 * (pure-block condense), the model's summary is used directly — prepending the
 * old block content verbatim would double the stored size and defeat the purpose.
 *
 * If the range mixes blocks and new messages, the old block content is preserved
 * alongside the new summary so nothing is silently dropped.
 */
export function selectFinalSummary(preservedSummaries, newSummary, nonBlockMessageIds) {
    if (nonBlockMessageIds.length === 0) {
        // Pure-block condense: model already has all block content in context,
        // so its summary IS the condensed version — no need to re-wrap originals.
        return newSummary.trim();
    }
    return composeSummaryWithPreservedBlocks(preservedSummaries, newSummary);
}
function buildCompressReceipt(topic, blockId, continueTask = false) {
    const stored = blockId
        ? `Compression complete. Stored [${blockId}] "${topic}".`
        : `Compression complete. Stored "${topic}".`;
    return continueTask
        ? `${stored} Continue the original task now from the preserved active tail; do not stop for a compression report.`
        : stored;
}
export function createCompressTool(ctx) {
    return tool({
        description: COMPRESS_TOOL_DESCRIPTION,
        args: {
            from: tool.schema
                .union([tool.schema.number(), tool.schema.string()])
                .describe("Range start index from <compress-context-map>, or block reference like 'b1'"),
            to: tool.schema
                .union([tool.schema.number(), tool.schema.string()])
                .describe("Range end index from <compress-context-map>, or block reference like 'b1'"),
            summary: tool.schema
                .string()
                .describe("Complete technical summary replacing NEW content in this range"),
            topic: tool.schema
                .string()
                .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        },
        async execute(args, toolCtx) {
            const { client, stateManager, logger } = ctx;
            const sessionId = toolCtx.sessionID;
            const state = stateManager.get(sessionId);
            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            });
            const range = args;
            if (typeof range !== "object" || !range) {
                throw new Error("compress requires { from, to, summary, topic }");
            }
            if (!range.topic || typeof range.topic !== "string") {
                throw new Error("compress requires a non-empty topic");
            }
            if (!range.summary || typeof range.summary !== "string") {
                throw new Error("compress requires a non-empty summary");
            }
            if ((typeof range.from !== "number" && typeof range.from !== "string") ||
                (typeof range.to !== "number" && typeof range.to !== "string")) {
                throw new Error("compress requires valid from/to range boundaries");
            }
            const rawMessages = (await listSessionMessages(client, sessionId));
            await ensureSessionInitialized(client, state, sessionId, logger, rawMessages);
            const currentParams = getCurrentParams(state, rawMessages, logger);
            const activeManagementTurn = findActiveManagementTurn(state, rawMessages);
            const contextMap = buildContextMap(rawMessages, state, logger, currentParams.providerId);
            const baselineSummaries = [...state.compressSummaries];
            const baselineSummariesByAnchor = new Map(baselineSummaries.map((summary) => [summary.anchorMessageId, summary]));
            const rawMessageIndexById = new Map(rawMessages.map((message, index) => [message.info.id, index]));
            const resolvedRange = resolveContextMapRange(contextMap, range.from, range.to);
            if (activeManagementTurn?.turn.source === "automatic" &&
                resolvedRange.entries.some((entry) => entry.protected)) {
                throw new Error("Automatic compression cannot include entries labeled [protected active tail]. Select an older range.");
            }
            const rangeMetrics = calculateCompressionRangeMetrics(rawMessages, rawMessageIndexById, resolvedRange, currentParams.providerId);
            const containedMessageIds = rangeMetrics.messageIds;
            if (containedMessageIds.length === 0) {
                throw new Error("Could not resolve raw message IDs for the requested range");
            }
            const preservedSummaries = resolvedRange.entries
                .filter((entry) => entry.kind === "block" && typeof entry.anchorMessageId === "string")
                .map((entry) => baselineSummariesByAnchor.get(entry.anchorMessageId)?.summary)
                .filter((summary) => typeof summary === "string" && summary.length > 0);
            const finalSummary = selectFinalSummary(preservedSummaries, range.summary, rangeMetrics.nonBlockMessageIds);
            const containedToolIds = rangeMetrics.toolIds;
            const startEntry = contextMap.entries[resolvedRange.startPosition];
            const anchorMessageId = startEntry?.kind === "block" && startEntry.anchorMessageId
                ? startEntry.anchorMessageId
                : containedMessageIds[0];
            const candidateCompressed = {
                toolIds: new Set(state.compressed.toolIds),
                messageIds: new Set(state.compressed.messageIds),
            };
            for (const id of containedToolIds) {
                candidateCompressed.toolIds.add(id);
            }
            for (const id of containedMessageIds) {
                candidateCompressed.messageIds.add(id);
            }
            const candidateSummaries = removeSubsumedCompressSummaries(state.compressSummaries, containedMessageIds);
            candidateSummaries.push({
                anchorMessageId,
                messageIds: containedMessageIds,
                summary: finalSummary,
                topic: range.topic,
            });
            const completedAt = new Date().toISOString();
            const candidateManagementTurns = activeManagementTurn
                ? state.managementTurns.map((turn) => turn === activeManagementTurn.turn
                    ? {
                        ...turn,
                        completedAt,
                        ...(typeof toolCtx.callID === "string" && toolCtx.callID
                            ? { completedCallId: toolCtx.callID }
                            : {}),
                        completedMessageId: toolCtx.messageID,
                    }
                    : turn)
                : [...state.managementTurns];
            const candidateStats = {
                compressTokenCounter: 0,
                totalCompressTokens: state.stats.totalCompressTokens + rangeMetrics.incrementalCompressTokens,
            };
            const candidateState = {
                ...state,
                compressed: candidateCompressed,
                compressSummaries: candidateSummaries,
                managementTurns: candidateManagementTurns,
                stats: candidateStats,
            };
            const persisted = await saveSessionState(candidateState, logger);
            if (!persisted) {
                throw new Error("compress could not persist compression state - the range was not compressed");
            }
            // Commit only now that the new state is durable, so a failed save leaves the
            // live in-memory state exactly as it was and no transform hides content as if
            // compression had succeeded.
            state.compressed = candidateState.compressed;
            state.compressSummaries = candidateState.compressSummaries;
            state.managementTurns = candidateState.managementTurns;
            state.stats = candidateState.stats;
            state.hasPersistedState = candidateState.hasPersistedState;
            state.persistedLastUpdated = candidateState.persistedLastUpdated;
            await sendCompressNotification(client, logger, ctx.config, state, sessionId, containedToolIds, rangeMetrics.mapEntryCount, range.topic, finalSummary, { messageIndex: resolvedRange.startPosition }, { messageIndex: resolvedRange.endPosition }, contextMap.entries.length, currentParams, rangeMetrics.estimatedCompressedTokens);
            const updatedContextMap = buildContextMap(rawMessages, state, logger, currentParams.providerId);
            const storedBlockId = updatedContextMap.entries.find((entry) => entry.kind === "block" && entry.anchorMessageId === anchorMessageId)?.key;
            return buildCompressReceipt(range.topic, storedBlockId, activeManagementTurn?.turn.source === "automatic");
        },
    });
}
//# sourceMappingURL=compress.js.map