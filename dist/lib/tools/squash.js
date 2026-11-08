import { commitDurableSessionState, reconcileSessionLifecycle } from "../state/index.js";
import { saveSessionState } from "../state/persistence.js";
import { loadPrompt, renderPostCompressionNotice } from "../prompts/index.js";
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
                };
                const persisted = await saveSessionState(candidateState, logger);
                if (!persisted) {
                    throw new Error("squash could not persist compression state. Nothing changed.");
                }
                commitDurableSessionState(state, candidateState);
                return {
                    requestedBy: managementTurn
                        ? managementTurn.triggeredByMessageId
                            ? "automatic"
                            : "user"
                        : undefined,
                    oldFrom: selected[0].label,
                    oldTo: selected[selected.length - 1].label,
                    newLabel: replacementLabel,
                    topic,
                    selectedBlocks: selected.length,
                    blocksBefore: orderedBlocks.length,
                    blocksAfter: candidateSummaries.length,
                    moved: orderedBlocks.slice(toIndex + 1).map((block, index) => ({
                        from: block.label,
                        to: `b${fromIndex + 1 + index}`,
                        topic: block.summary.topic,
                    })),
                    oldVisibleTokens,
                    newVisibleTokens,
                };
            });
            await sendSquashNotification(client, logger, ctx.config, sessionId, outcome);
            // The receipt is the only post-squash message the agent sees, and the trigger message is
            // hidden once the turn completes, so it says who asked.
            const opening = outcome.requestedBy === "automatic"
                ? "Automatic squash finished. The plugin started it because the compressed blocks passed their automatic squash threshold."
                : outcome.requestedBy === "user"
                    ? "Squash finished, as the user requested with /compress squash."
                    : "Squash finished.";
            // Labels are positions, so every later block is renumbered while this call's from/to and the agent's
            // earlier reasoning keep the old numbers. Without the mapping, agents read a moved block under a reused
            // label as one they just merged and concluded the squash lost it.
            const moved = outcome.moved.length
                ? ` Later blocks moved up, so only their labels changed:\n${outcome.moved.map((block) => `- [${block.from}] is now [${block.to}]${block.topic ? ` "${block.topic}"` : ""}`).join("\n")}\nLabels in earlier messages, including this call's from and to, use the old numbering.`
                : "";
            return `${opening} Blocks [${outcome.oldFrom}]-[${outcome.oldTo}] are now one block, [${outcome.newLabel}] "${outcome.topic}". No other block changed; each is still in context word for word, and the recent conversation is untouched.${moved}\n\n${renderPostCompressionNotice()}`;
        },
    };
}
//# sourceMappingURL=squash.js.map