import { startManagementTurn } from "./commands/manage.js";
import { findActiveManagementTurn } from "./messages/compress-transform.js";
import { renderAutomaticSystemPrompt } from "./prompts/index.js";
import { listSessionMessages, showToast } from "./sdk/client.js";
import { ensureSessionInitialized } from "./state/index.js";
function positiveFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
export function getAssistantContextTokens(tokens) {
    if (!tokens)
        return 0;
    const reportedTotal = positiveFinite(tokens.total);
    if (reportedTotal > 0)
        return reportedTotal;
    return (positiveFinite(tokens.input) +
        positiveFinite(tokens.output) +
        positiveFinite(tokens.reasoning) +
        positiveFinite(tokens.cache?.read) +
        positiveFinite(tokens.cache?.write));
}
export function resolveAutomaticCompressionThreshold(contextTokens, config, contextLimit) {
    const normalizedContextLimit = positiveFinite(contextLimit) || undefined;
    const relativeThresholdTokens = normalizedContextLimit
        ? Math.floor(normalizedContextLimit * config.contextWindowRatio)
        : undefined;
    const thresholdTokens = relativeThresholdTokens
        ? Math.min(relativeThresholdTokens, config.tokenThreshold)
        : config.tokenThreshold;
    return {
        contextTokens,
        thresholdTokens,
        relativeThresholdTokens,
        contextLimit: normalizedContextLimit,
        reason: relativeThresholdTokens !== undefined && relativeThresholdTokens <= config.tokenThreshold
            ? "context-window-ratio"
            : "absolute-token-threshold",
    };
}
export function createChatParamsHandler(stateManager) {
    return async (input) => {
        const contextLimit = positiveFinite(input.model.limit?.context);
        const modelId = input.model.id ?? input.model.modelID;
        const providerId = input.model.providerID;
        if (!contextLimit || !modelId || !providerId)
            return;
        stateManager.get(input.sessionID).modelContext = {
            providerId,
            modelId,
            contextLimit,
        };
    };
}
function findContextLimit(stateManager, info) {
    const cached = stateManager.get(info.sessionID).modelContext;
    if (!cached)
        return undefined;
    if (info.providerID && cached.providerId !== info.providerID)
        return undefined;
    if (info.modelID && cached.modelId !== info.modelID)
        return undefined;
    return cached.contextLimit;
}
function messageContainsCompressCall(message) {
    return !!message?.parts?.some((part) => part.type === "tool" && part.tool === "compress");
}
function formatThresholdReason(result, ratio) {
    return result.reason === "context-window-ratio"
        ? `${Math.round(ratio * 100)}% of the model-reported context window`
        : "the system-wide absolute token limit";
}
export function createAutomaticCompressionEventHandler(client, stateManager, logger, config) {
    return async (input) => {
        if (!config.autoCompression.enabled || config.tools.compress.permission === "deny")
            return;
        if (input.event?.type !== "message.updated")
            return;
        const info = input.event.properties?.info;
        if (!info ||
            info.role !== "assistant" ||
            info.summary === true ||
            info.error ||
            !info.time?.completed) {
            return;
        }
        const contextTokens = getAssistantContextTokens(info.tokens);
        const threshold = resolveAutomaticCompressionThreshold(contextTokens, config.autoCompression, findContextLimit(stateManager, info));
        if (contextTokens < threshold.thresholdTokens)
            return;
        const state = stateManager.get(info.sessionID);
        if (state.isSubAgent ||
            state.autoCompressionStarting ||
            state.lastAutoTriggeredMessageId === info.id) {
            return;
        }
        state.autoCompressionStarting = true;
        state.lastAutoTriggeredMessageId = info.id;
        try {
            const messages = (await listSessionMessages(client, info.sessionID));
            if (messages.length === 0) {
                logger.warn("Automatic compression skipped because session messages were unavailable", {
                    sessionId: info.sessionID,
                    messageId: info.id,
                });
                return;
            }
            await ensureSessionInitialized(client, state, info.sessionID, logger, messages);
            if (state.isSubAgent) {
                logger.debug("Automatic compression skipped for subagent session", {
                    sessionId: info.sessionID,
                });
                return;
            }
            if (state.managementTurns.some((turn) => turn.source === "automatic" &&
                turn.triggeredByMessageId === info.id)) {
                return;
            }
            if (findActiveManagementTurn(state, messages))
                return;
            if (messageContainsCompressCall(messages.find((message) => message.info.id === info.id)))
                return;
            const flags = {
                compress: true,
                compress_map: config.tools.compress_map.permission !== "deny",
            };
            const started = await startManagementTurn({
                client,
                state,
                config,
                logger,
                sessionId: info.sessionID,
                messages,
                systemPrompt: renderAutomaticSystemPrompt(flags, {
                    context_tokens: contextTokens.toLocaleString("en-US"),
                    threshold_tokens: threshold.thresholdTokens.toLocaleString("en-US"),
                    threshold_reason: formatThresholdReason(threshold, config.autoCompression.contextWindowRatio),
                }),
                source: "automatic",
                triggeredByMessageId: info.id,
                contextTokens,
                thresholdTokens: threshold.thresholdTokens,
                protectedTurns: config.autoCompression.protectedTurns,
                asyncPrompt: true,
            });
            if (started) {
                logger.info("Automatic compression initiated", {
                    sessionId: info.sessionID,
                    messageId: info.id,
                    contextTokens,
                    thresholdTokens: threshold.thresholdTokens,
                    reason: threshold.reason,
                });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Automatic compression failed to start", {
                sessionId: info.sessionID,
                messageId: info.id,
                error: message,
            });
            await showToast(client, {
                title: "Automatic Compression",
                message: `Could not start automatic compression: ${message}`,
                variant: "error",
                duration: 8000,
            });
        }
        finally {
            state.autoCompressionStarting = false;
        }
    };
}
//# sourceMappingURL=auto-compression.js.map