import { tool } from "@opencode-ai/plugin/tool";
import { commitDurableSessionState, reconcileSessionLifecycle } from "../state/index.js";
import { saveSessionState } from "../state/persistence.js";
import { loadPrompt } from "../prompts/index.js";
import { estimateTokensBatch } from "../token-utils.js";
import { collectContentInRange, collectToolIdsInRange } from "./utils.js";
import { sendCompressNotification } from "../ui/notification.js";
import { selectDeterministicCompressionSpan } from "../messages/context-map.js";
import { findActiveManagementTurn } from "../messages/compress-transform.js";
import { isIgnoredUserMessage } from "../messages/utils.js";
import { isGoalContinuationMessage, recoverGoalAfterCompression } from "../goal.js";
import { listSessionMessages } from "../sdk/client.js";
import { getPostCompressionCooldownRemaining } from "../auto-policy.js";
const COMPRESS_TOOL_DESCRIPTION = loadPrompt("compress-tool-spec");
function isVisibleUserMessage(message) {
    return (message.info.role === "user" &&
        !isIgnoredUserMessage(message) &&
        !isGoalContinuationMessage(message));
}
function findExecutingToolMessage(rawMessages, messageId, callId) {
    const matches = rawMessages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.info.id === messageId);
    if (matches.length !== 1 || matches[0].message.info.role !== "assistant")
        return undefined;
    const hasExecutingCall = matches[0].message.parts.some((part) => part.type === "tool" &&
        part.tool === "compress" &&
        (!callId || part.callID === callId));
    return hasExecutingCall ? matches[0] : undefined;
}
export function resolveCompressionBoundary(rawMessages, state, toolMessageId, callId) {
    const activeTurn = findActiveManagementTurn(state, rawMessages);
    if (activeTurn) {
        return {
            history: rawMessages.slice(0, activeTurn.triggerIndex),
            managementTurn: activeTurn.turn,
        };
    }
    const executing = findExecutingToolMessage(rawMessages, toolMessageId, callId);
    if (!executing) {
        throw new Error("compress could not identify the executing tool call in the current session. Nothing was compressed.");
    }
    const parentId = executing.message.info.parentID;
    if (typeof parentId !== "string" || parentId.length === 0) {
        throw new Error("compress could not identify the visible user turn that owns this call. Nothing was compressed.");
    }
    const parentMatches = rawMessages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.info.id === parentId && isVisibleUserMessage(message));
    if (parentMatches.length !== 1 || parentMatches[0].index >= executing.index) {
        throw new Error("compress could not unambiguously resolve this call's visible user boundary. Nothing was compressed.");
    }
    const owner = parentMatches[0];
    const matchingManagementTurn = [...state.managementTurns]
        .reverse()
        .find((turn) => !turn.completedAt && turn.triggerMessageId === parentId);
    if (matchingManagementTurn) {
        return {
            history: rawMessages.slice(0, owner.index),
            managementTurn: matchingManagementTurn,
        };
    }
    const interveningVisibleUser = rawMessages
        .slice(owner.index + 1, executing.index)
        .some(isVisibleUserMessage);
    if (interveningVisibleUser) {
        throw new Error("compress found another visible user turn between this call and its owner. Nothing was compressed.");
    }
    return { history: rawMessages.slice(0, owner.index) };
}
function buildCompressReceipt(topic, blockId, restoreDisposition) {
    const stored = `Compression complete. Stored [${blockId}] "${topic}" durably; the fold is already in effect.`;
    const finish = `${stored} Do not call compress again this turn.`;
    return restoreDisposition
        ? `${finish} Automatic compression finished. Continue the original work now, unless the preserved execution steps show it was already complete or awaiting the user.`
        : finish;
}
export function createCompressTool(ctx) {
    return tool({
        description: COMPRESS_TOOL_DESCRIPTION,
        args: {
            summary: tool.schema
                .string()
                .describe("Truthful durable replacement for all eligible history"),
            topic: tool.schema
                .string()
                .describe("Short block title, usually 3-5 words"),
        },
        async execute(args, toolCtx) {
            const { client, stateManager, logger } = ctx;
            const sessionId = toolCtx.sessionID;
            const state = stateManager.get(sessionId);
            const input = args;
            const summary = typeof input.summary === "string" ? input.summary.trim() : "";
            const topic = typeof input.topic === "string" ? input.topic.trim() : "";
            if (!summary)
                throw new Error("compress requires a non-empty summary");
            if (!topic)
                throw new Error("compress requires a non-empty topic");
            const outcome = await stateManager.runExclusive(sessionId, async () => {
                let rawMessages;
                try {
                    rawMessages = (await listSessionMessages(client, sessionId));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(`compress could not fetch session messages: ${message}. Nothing was compressed.`);
                }
                if (rawMessages.length === 0) {
                    throw new Error("compress could not fetch any session messages. Nothing was compressed.");
                }
                await reconcileSessionLifecycle(client, state, sessionId, logger, rawMessages);
                if (!state.persistenceSynchronized) {
                    throw new Error("compress could not synchronize saved session state. Nothing was compressed.");
                }
                const boundary = resolveCompressionBoundary(rawMessages, state, toolCtx.messageID, typeof toolCtx.callID === "string" ? toolCtx.callID : undefined);
                if (!boundary.managementTurn &&
                    getPostCompressionCooldownRemaining(state, rawMessages) > 0) {
                    const remaining = getPostCompressionCooldownRemaining(state, rawMessages);
                    throw new Error(`Compression succeeded recently. Nothing was compressed. Wait ${remaining} more assistant ${remaining === 1 ? "response" : "responses"}. Only the user may override this cooldown by explicitly running \`/compress manage\`.`);
                }
                const span = selectDeterministicCompressionSpan(boundary.history, state, logger, ctx.config.protectedTurns);
                if (span.messages.length === 0) {
                    return { kind: "empty" };
                }
                const containedToolIds = collectToolIdsInRange(span.messages, 0, span.messages.length - 1);
                const estimatedCompressedTokens = estimateTokensBatch(collectContentInRange(span.messages, 0, span.messages.length - 1), state.modelContext?.providerId);
                await toolCtx.ask({
                    permission: "compress",
                    patterns: ["*"],
                    always: ["*"],
                    metadata: {},
                });
                const candidateCompressed = {
                    toolIds: new Set(state.compressed.toolIds),
                    messageIds: new Set(state.compressed.messageIds),
                };
                for (const id of containedToolIds)
                    candidateCompressed.toolIds.add(id);
                for (const id of span.messageIds)
                    candidateCompressed.messageIds.add(id);
                const anchorMessageId = span.messageIds[0];
                const candidateSummaries = [
                    ...state.compressSummaries,
                    {
                        anchorMessageId,
                        messageIds: span.messageIds,
                        summary,
                        topic,
                    },
                ];
                const completedAt = new Date().toISOString();
                const candidateManagementTurns = boundary.managementTurn
                    ? state.managementTurns.map((turn) => turn === boundary.managementTurn
                        ? {
                            ...turn,
                            completedAt,
                            ...(typeof toolCtx.callID === "string" &&
                                toolCtx.callID
                                ? { completedCallId: toolCtx.callID }
                                : {}),
                            completedMessageId: toolCtx.messageID,
                        }
                        : turn)
                    : [...state.managementTurns];
                const candidateState = {
                    ...state,
                    compressed: candidateCompressed,
                    compressSummaries: candidateSummaries,
                    managementTurns: candidateManagementTurns,
                    stats: {
                        compressTokenCounter: 0,
                        totalCompressTokens: state.stats.totalCompressTokens + estimatedCompressedTokens,
                    },
                    compressionCooldownAfterMessageId: toolCtx.messageID,
                    compressionMapSnapshot: undefined,
                };
                const persisted = await saveSessionState(candidateState, logger);
                if (!persisted) {
                    throw new Error("compress could not persist compression state. Nothing was compressed.");
                }
                commitDurableSessionState(state, candidateState);
                return {
                    kind: "compressed",
                    containedToolIds,
                    selectedMessageCount: span.messageIds.length,
                    visibleHistoryCount: span.messageIds.length + span.protectedMessageIds.length,
                    topic,
                    summary,
                    estimatedCompressedTokens,
                    storedBlockId: `b${candidateSummaries.length - 1}`,
                    continueTask: boundary.managementTurn?.source === "automatic",
                    goalOverflowRecovery: boundary.managementTurn?.triggeredByMessageId ===
                        state.goalOverflowRecovery?.overflowMessageId
                        ? state.goalOverflowRecovery
                        : undefined,
                    currentParams: {
                        providerId: state.modelContext?.providerId,
                        modelId: state.modelContext?.modelId,
                        agent: toolCtx.agent,
                        variant: state.variant,
                    },
                };
            });
            if (outcome.kind === "empty") {
                return "Nothing eligible to compress. The newest configured execution steps and existing blocks remain unchanged.";
            }
            await sendCompressNotification(client, logger, ctx.config, state, sessionId, outcome.containedToolIds, outcome.selectedMessageCount, outcome.topic, outcome.summary, { messageIndex: 0 }, { messageIndex: outcome.selectedMessageCount - 1 }, outcome.visibleHistoryCount, outcome.currentParams, outcome.estimatedCompressedTokens);
            const recovery = outcome.goalOverflowRecovery
                ? await recoverGoalAfterCompression(client, sessionId, outcome.goalOverflowRecovery)
                : undefined;
            const receipt = buildCompressReceipt(outcome.topic, outcome.storedBlockId, recovery ? recovery === "resumed" : outcome.continueTask);
            if (recovery === "changed") {
                return `${receipt} The blocked Goal changed, so it was not resumed.`;
            }
            if (recovery === "unavailable") {
                return `${receipt} Goal recovery is unavailable on this host, so no Goal was resumed.`;
            }
            return receipt;
        },
    });
}
//# sourceMappingURL=compress.js.map