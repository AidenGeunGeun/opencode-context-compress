import { commitDurableSessionState, reconcileSessionLifecycle } from "../state/index.js";
import { saveSessionState } from "../state/persistence.js";
import { loadPrompt } from "../prompts/index.js";
import { estimateTokensBatch } from "../token-utils.js";
import { findActiveManagementTurn } from "../messages/compress-transform.js";
import { formatCompressBlockContent, orderCompressBlocks, } from "../messages/blocks.js";
import { listSessionMessages } from "../sdk/client.js";
import { sendSquashNotification } from "../ui/notification.js";
const SQUASH_TOOL_DESCRIPTION = loadPrompt("squash-tool-spec");
const BLOCK_LABEL = /^b(?:0|[1-9]\d*)$/;
function parseBlockLabel(value, field) {
    if (typeof value !== "string" || !BLOCK_LABEL.test(value)) {
        throw new Error(`squash requires ${field} to be a current block label such as b1`);
    }
    const index = Number(value.slice(1));
    if (!Number.isSafeInteger(index)) {
        throw new Error(`squash requires ${field} to be a current block label such as b1`);
    }
    return index;
}
function buildReplacement(selected, summary, topic) {
    const messageIds = [];
    const seen = new Set();
    for (const block of selected) {
        for (const messageId of block.summary.messageIds) {
            if (!seen.has(messageId)) {
                seen.add(messageId);
                messageIds.push(messageId);
            }
        }
    }
    return {
        anchorMessageId: selected[0].summary.anchorMessageId,
        messageIds,
        summary,
        topic,
    };
}
export function createSquashTool(ctx) {
    return {
        description: SQUASH_TOOL_DESCRIPTION,
        args: {
            from: { type: "string", description: "Inclusive current block label, for example b1" },
            to: { type: "string", description: "Inclusive current block label, for example b12" },
            summary: {
                type: "string",
                description: "Truthful replacement for only the selected blocks",
            },
            topic: { type: "string", description: "Short replacement block title" },
        },
        async execute(args, toolCtx) {
            const input = args;
            const fromIndex = parseBlockLabel(input.from, "from");
            const toIndex = parseBlockLabel(input.to, "to");
            const summary = typeof input.summary === "string" ? input.summary.trim() : "";
            const topic = typeof input.topic === "string" ? input.topic.trim() : "";
            if (!summary)
                throw new Error("squash requires a non-empty summary");
            if (!topic)
                throw new Error("squash requires a non-empty topic");
            const { client, stateManager, logger } = ctx;
            const sessionId = toolCtx.sessionID;
            const state = stateManager.get(sessionId);
            const outcome = await stateManager.runExclusive(sessionId, async () => {
                let rawMessages;
                try {
                    rawMessages = await listSessionMessages(client, sessionId);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(`squash could not fetch session messages: ${message}. Nothing changed.`);
                }
                if (rawMessages.length === 0) {
                    throw new Error("squash could not fetch any session messages. Nothing changed.");
                }
                await reconcileSessionLifecycle(state, sessionId, logger, rawMessages);
                if (!state.persistenceSynchronized) {
                    throw new Error("squash could not synchronize saved session state. Nothing changed.");
                }
                const orderedBlocks = orderCompressBlocks(rawMessages, state.compressSummaries);
                const active = findActiveManagementTurn(state, rawMessages);
                const managementTurn = active?.turn.source === "squash" ? active.turn : undefined;
                if (fromIndex > toIndex) {
                    throw new Error("squash requires from to precede or equal to to. Nothing changed.");
                }
                if (fromIndex >= orderedBlocks.length || toIndex >= orderedBlocks.length) {
                    throw new Error("squash block range does not exist in the current block ordering. Nothing changed.");
                }
                if (toIndex - fromIndex + 1 < 2) {
                    throw new Error("squash requires a range containing at least two blocks. Nothing changed.");
                }
                const selected = orderedBlocks.slice(fromIndex, toIndex + 1);
                const replacement = buildReplacement(selected, summary, topic);
                const replacementLabel = selected[0].label;
                const oldVisibleTokens = estimateTokensBatch(selected.map(formatCompressBlockContent), state.modelContext?.providerId);
                const newVisibleTokens = estimateTokensBatch([formatCompressBlockContent({ label: replacementLabel, summary: replacement })], state.modelContext?.providerId);
                const estimatedSavedTokens = Math.max(0, oldVisibleTokens - newVisibleTokens);
                const orderedSummaries = orderedBlocks.map((block) => block.summary);
                const candidateSummaries = [
                    ...orderedSummaries.slice(0, fromIndex),
                    replacement,
                    ...orderedSummaries.slice(toIndex + 1),
                ];
                const completedAt = new Date().toISOString();
                const candidateManagementTurns = managementTurn
                    ? state.managementTurns.map((turn) => turn === managementTurn
                        ? {
                            ...turn,
                            completedAt,
                            completedMessageId: toolCtx.messageID,
                        }
                        : turn)
                    : [...state.managementTurns];
                const candidateState = {
                    ...state,
                    compressSummaries: candidateSummaries,
                    managementTurns: candidateManagementTurns,
                    stats: {
                        compressTokenCounter: 0,
                        totalCompressTokens: state.stats.totalCompressTokens + estimatedSavedTokens,
                    },
                    compressionMapSnapshot: undefined,
                };
                const persisted = await saveSessionState(candidateState, logger);
                if (!persisted) {
                    throw new Error("squash could not persist compression state. Nothing changed.");
                }
                commitDurableSessionState(state, candidateState);
                return {
                    oldFrom: selected[0].label,
                    oldTo: selected[selected.length - 1].label,
                    newLabel: replacementLabel,
                    topic,
                    selectedBlocks: selected.length,
                    blocksBefore: orderedBlocks.length,
                    blocksAfter: candidateSummaries.length,
                    oldVisibleTokens,
                    newVisibleTokens,
                };
            });
            await sendSquashNotification(client, logger, ctx.config, sessionId, outcome);
            return `Squash complete. Replaced [${outcome.oldFrom}]-[${outcome.oldTo}] with [${outcome.newLabel}] "${outcome.topic}" durably; the replacement is already in effect. Uncompressed history was untouched. Do not call squash or compress again this turn.`;
        },
    };
}
//# sourceMappingURL=squash.js.map