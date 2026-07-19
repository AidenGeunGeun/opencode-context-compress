import { commitDurableSessionState } from "../state/state.js";
import { renderSystemPrompt } from "../prompts/index.js";
import { getCurrentParams } from "../token-utils.js";
import { syncToolCache } from "../state/tool-cache.js";
import { saveSessionState } from "../state/persistence.js";
import { sendIgnoredMessage } from "../ui/notification.js";
import { deriveAutomaticProtectedTail } from "../messages/context-map.js";
import { promptSession, promptSessionAsync, showToast } from "../sdk/client.js";
const COMPRESSION_ONLY_TEXT = /^(?:(?:please|pls|kindly|can you|could you|would you|now|thanks|thank you|context|conversation|history|manage|management|compress|compression|compact|cleanup|clean|up|prune|summari[sz]e|old|older|completed|past|previous|messages|turns|work|range|ranges|blocks?|cache|the|my|this|that|our|session|for|to|and|all|some|a|an|it|do|run|just)[\s,.;:!?-]*)+$/i;
const LEADING_COMPRESSION_REQUEST = /^\s*(?:(?:please|pls|kindly)\s+)?(?:compress|manage|compact|clean\s+up|cleanup|prune|summari[sz]e)(?:\s+(?:the|this|that|our|my|old|older|past|previous|completed|conversation|context|history|messages|turns|work|session|blocks?|ranges?))*\s*(?:now|please)?\s*(?:[:;,.!-]+\s*)/i;
const LEADING_COMPRESSION_REQUEST_WITH_CONJUNCTION = /^\s*(?:(?:please|pls|kindly)\s+)?(?:compress|manage|compact|clean\s+up|cleanup|prune|summari[sz]e)(?:\s+(?:the|this|that|our|my|old|older|past|previous|completed|conversation|context|history|messages|turns|work|session|blocks?|ranges?))*\s+(?:and|also|but)\b\s*/i;
function trimCommandBoundary(text) {
    return text.replace(/^[\s:;,.|\-]+/, "").replace(/\s+$/, "");
}
export function extractManageCommandResidual(args) {
    const withoutSubcommand = (args || "").replace(/^\s*manage\b/i, "");
    const initial = trimCommandBoundary(withoutSubcommand);
    if (!initial) {
        return undefined;
    }
    let residual = initial;
    const stripped = residual
        .replace(LEADING_COMPRESSION_REQUEST, "")
        .replace(LEADING_COMPRESSION_REQUEST_WITH_CONJUNCTION, "");
    if (stripped !== residual) {
        residual = stripped.replace(/^\s*(?:and|also|but)\b[\s,]*/i, "");
    }
    residual = trimCommandBoundary(residual);
    if (!residual || COMPRESSION_ONLY_TEXT.test(residual)) {
        return undefined;
    }
    return residual;
}
const ASCENDING_ID_RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastGeneratedMessageIdTimestamp = 0;
let lastGeneratedMessageIdCounter = 0;
function generateAscendingMessageIdSuffix(timestamp = Date.now()) {
    if (timestamp !== lastGeneratedMessageIdTimestamp) {
        lastGeneratedMessageIdTimestamp = timestamp;
        lastGeneratedMessageIdCounter = 0;
    }
    lastGeneratedMessageIdCounter++;
    const current = BigInt(timestamp) * 0x1000n + BigInt(lastGeneratedMessageIdCounter);
    const time = Array.from({ length: 6 }, (_, index) => Number((current >> BigInt(40 - 8 * index)) & 0xffn)
        .toString(16)
        .padStart(2, "0")).join("");
    const random = Array.from({ length: 14 }, () => ASCENDING_ID_RANDOM_CHARS[Math.floor(Math.random() * ASCENDING_ID_RANDOM_CHARS.length)]).join("");
    return time + random;
}
export function generateManagePromptMessageId() {
    return `msg_${generateAscendingMessageIdSuffix()}`;
}
/**
 * Best-effort sanity check only. The generated trigger ID passed via `messageID` on the
 * prompt call is the source of truth for cleanup anchoring - the assistant response's
 * `parentID` is not trusted, since OpenCode can bind it to whatever user message was most
 * recently created in the session (e.g. a mid-turn ignored status notification), not
 * necessarily the message that actually started this turn.
 */
function extractPromptParentIdForLogging(promptResult) {
    const result = promptResult?.data ?? promptResult;
    const info = result?.info;
    if (!info || typeof info !== "object") {
        return undefined;
    }
    return typeof info.parentID === "string" && info.parentID.length > 0 ? info.parentID : undefined;
}
async function sendManageFailureFeedback(client, logger, sessionId, message, params) {
    if (await showToast(client, {
        title: "Compression Management",
        message,
        variant: "error",
        duration: 8000,
    })) {
        return;
    }
    if (typeof client?.session?.prompt === "function") {
        await sendIgnoredMessage(client, sessionId, message, params, logger);
        return;
    }
    logger.error("Unable to surface compression management error to user", { sessionId, message });
}
export async function handleManageCommand(ctx) {
    const flags = {
        compress: ctx.config.tools.compress.permission !== "deny",
        compress_map: ctx.config.tools.compress_map.permission !== "deny",
    };
    if (!flags.compress || !flags.compress_map) {
        const unavailable = [
            !flags.compress_map ? "compress_map" : undefined,
            !flags.compress ? "compress" : undefined,
        ].filter(Boolean);
        await sendManageFailureFeedback(ctx.client, ctx.logger, ctx.sessionId, `Compression management did not start because ${unavailable.join(" and ")} ${unavailable.length === 1 ? "is" : "are"} denied. Enable both compression tools, then run \`/compress manage\` again.`, getCurrentParams(ctx.state, ctx.messages, ctx.logger));
        return;
    }
    await startManagementTurn({
        client: ctx.client,
        stateManager: ctx.stateManager,
        state: ctx.state,
        config: ctx.config,
        logger: ctx.logger,
        sessionId: ctx.sessionId,
        messages: ctx.messages,
        systemPrompt: renderSystemPrompt(flags),
        retainedText: extractManageCommandResidual(ctx.arguments),
    });
}
/** Persists the turn marker; the caller must hold this session's mutation lock. */
export async function stageManagementTurnWithinLock(ctx) {
    const { client, stateManager, state, config, logger, sessionId, messages } = ctx;
    const currentParams = getCurrentParams(state, messages, logger);
    if (!state.persistenceSynchronized) {
        return async () => {
            await sendManageFailureFeedback(client, logger, sessionId, "Compression management could not start because saved session state could not be loaded.", currentParams);
            return false;
        };
    }
    await syncToolCache(state, config, logger, messages);
    const automaticTail = ctx.source === "automatic"
        ? deriveAutomaticProtectedTail(messages, state, logger, ctx.protectedTurns ?? 0)
        : undefined;
    if (ctx.source === "automatic" &&
        !automaticTail?.hasSelectableMessages) {
        logger.warn("Automatic compression skipped because the protected tail covers all selectable messages", {
            sessionId,
            protectedTurns: ctx.protectedTurns ?? 0,
        });
        return undefined;
    }
    const messageParts = [];
    if (ctx.systemPrompt) {
        messageParts.push({ type: "text", text: ctx.systemPrompt });
    }
    if (ctx.retainedText) {
        messageParts.push({
            type: "text",
            text: ["<user-message>", ctx.retainedText, "</user-message>"].join("\n"),
        });
    }
    const triggerMessageId = generateManagePromptMessageId();
    const managementTurn = {
        triggerMessageId,
        ...(ctx.retainedText ? { retainedText: ctx.retainedText } : {}),
        ...(ctx.source === "automatic" ? { source: "automatic" } : {}),
        ...(ctx.triggeredByMessageId ? { triggeredByMessageId: ctx.triggeredByMessageId } : {}),
        ...(ctx.source === "automatic"
            ? { protectedMessageIds: automaticTail?.protectedMessageIds ?? [] }
            : {}),
        ...(typeof ctx.contextTokens === "number" ? { contextTokens: ctx.contextTokens } : {}),
        ...(typeof ctx.thresholdTokens === "number" ? { thresholdTokens: ctx.thresholdTokens } : {}),
    };
    const candidateState = {
        ...state,
        managementTurns: [...state.managementTurns, managementTurn],
        compressionMapSnapshot: undefined,
        ...(ctx.goalOverflowRecovery ? { goalOverflowRecovery: ctx.goalOverflowRecovery } : {}),
    };
    const statePersisted = await saveSessionState(candidateState, logger);
    if (!statePersisted) {
        logger.error("Manage command aborted because cleanup state could not be persisted", {
            sessionId,
            triggerMessageId,
        });
        return async () => {
            await sendManageFailureFeedback(client, logger, sessionId, "Compression management could not start: cleanup state could not be saved.", currentParams);
            return false;
        };
    }
    commitDurableSessionState(state, candidateState);
    const model = currentParams.providerId && currentParams.modelId
        ? {
            providerID: currentParams.providerId,
            modelID: currentParams.modelId,
        }
        : undefined;
    return async () => {
        let promptResult;
        try {
            const sendPrompt = ctx.asyncPrompt ? promptSessionAsync : promptSession;
            promptResult = await sendPrompt(client, {
                sessionId,
                agent: currentParams.agent,
                model,
                variant: currentParams.variant,
                parts: messageParts,
                messageId: triggerMessageId,
            });
        }
        catch (err) {
            const rollbackResult = await stateManager.runExclusive(sessionId, async () => {
                const currentTurn = state.managementTurns.find((turn) => turn.triggerMessageId === triggerMessageId);
                if (!currentTurn)
                    return "removed";
                if (currentTurn.completedAt)
                    return "completed";
                const rollbackState = {
                    ...state,
                    managementTurns: state.managementTurns.filter((turn) => turn.triggerMessageId !== triggerMessageId),
                };
                const persisted = await saveSessionState(rollbackState, logger);
                if (!persisted)
                    return "failed";
                commitDurableSessionState(state, rollbackState);
                return "removed";
            });
            logger.error("Manage command failed", { error: err?.message });
            if (rollbackResult === "completed") {
                logger.warn("Manage prompt failed after compression completed; preserving the completed turn marker", {
                    sessionId,
                    triggerMessageId,
                });
            }
            else if (rollbackResult === "failed") {
                logger.error("Manage prompt failure marker could not be rolled back", {
                    sessionId,
                    triggerMessageId,
                });
            }
            await sendManageFailureFeedback(client, logger, sessionId, rollbackResult === "completed"
                ? `The compression management prompt reported an error after compression completed: ${err?.message || "the prompt failed."} The completed state was preserved.`
                : rollbackResult === "removed"
                    ? `Compression management could not start: ${err?.message || "the prompt failed."}`
                    : `Compression management could not start: ${err?.message || "the prompt failed."} Its saved cleanup marker could not be removed.`, currentParams);
            return false;
        }
        const returnedParentId = extractPromptParentIdForLogging(promptResult);
        if (returnedParentId && returnedParentId !== triggerMessageId) {
            logger.warn("Manage prompt result parentID differs from the generated trigger ID; keeping the generated ID as the cleanup anchor", {
                sessionId,
                triggerMessageId,
                returnedParentId,
            });
        }
        logger.info("Sent compression context to agent", {
            sessionId,
            triggerMessageId,
            source: ctx.source ?? "manual",
        });
        return true;
    };
}
export async function startManagementTurn(ctx) {
    const staged = await ctx.stateManager.runExclusive(ctx.sessionId, () => stageManagementTurnWithinLock(ctx));
    return staged ? staged() : false;
}
//# sourceMappingURL=manage.js.map