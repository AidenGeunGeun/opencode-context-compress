import { renderSystemPrompt } from "../prompts/index.js";
import { getCurrentParams } from "../token-utils.js";
import { syncToolCache } from "../state/tool-cache.js";
import { saveSessionState } from "../state/persistence.js";
import { sendIgnoredMessage } from "../ui/notification.js";
import { ulid } from "ulid";
import { promptSession, showToast } from "../sdk/client.js";
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
function createPendingManagementTurnId() {
    return `pending_compress_manage_${ulid()}`;
}
function removeManagementTurn(state, triggerMessageId) {
    state.managementTurns = state.managementTurns.filter((turn) => turn.triggerMessageId !== triggerMessageId);
}
function finalizeManagementTurnId(state, pendingId, triggerMessageId) {
    let finalized = false;
    state.managementTurns = state.managementTurns.map((turn) => {
        if (turn.triggerMessageId !== pendingId) {
            return turn;
        }
        finalized = true;
        return {
            ...turn,
            triggerMessageId,
        };
    });
    if (!finalized) {
        state.managementTurns.push({ triggerMessageId });
    }
    let keptFinalTurn = false;
    state.managementTurns = state.managementTurns.filter((turn) => {
        if (turn.triggerMessageId !== triggerMessageId) {
            return true;
        }
        if (keptFinalTurn) {
            return false;
        }
        keptFinalTurn = true;
        return true;
    });
}
function extractPromptTriggerMessageId(promptResult) {
    const result = promptResult?.data ?? promptResult;
    const info = result?.info;
    if (!info || typeof info !== "object") {
        return undefined;
    }
    if (typeof info.parentID === "string" && info.parentID.length > 0) {
        return info.parentID;
    }
    if (info.role === "user" && typeof info.id === "string" && info.id.length > 0) {
        return info.id;
    }
    return undefined;
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
    const { client, state, config, logger, sessionId, messages } = ctx;
    await syncToolCache(state, config, logger, messages);
    const flags = {
        compress: config.tools.compress.permission !== "deny",
        compress_map: config.tools.compress_map.permission !== "deny",
    };
    const parts = [];
    const systemPrompt = renderSystemPrompt(flags);
    if (systemPrompt) {
        parts.push(systemPrompt);
    }
    const retainedText = extractManageCommandResidual(ctx.arguments);
    if (retainedText) {
        parts.push(["<user-message>", retainedText, "</user-message>"].join("\n"));
    }
    const currentParams = getCurrentParams(state, messages, logger);
    const payload = parts.join("\n\n");
    const pendingManagementTurnId = createPendingManagementTurnId();
    state.managementTurns.push({
        triggerMessageId: pendingManagementTurnId,
        ...(retainedText ? { retainedText } : {}),
    });
    const statePersisted = await saveSessionState(state, logger);
    if (!statePersisted) {
        removeManagementTurn(state, pendingManagementTurnId);
        logger.error("Manage command aborted because cleanup state could not be persisted", {
            sessionId,
            pendingManagementTurnId,
        });
        await sendManageFailureFeedback(client, logger, sessionId, "Compression management could not start: cleanup state could not be saved.", currentParams);
        return;
    }
    const model = currentParams.providerId && currentParams.modelId
        ? {
            providerID: currentParams.providerId,
            modelID: currentParams.modelId,
        }
        : undefined;
    let promptResult;
    try {
        promptResult = await promptSession(client, {
            sessionId,
            agent: currentParams.agent,
            model,
            variant: currentParams.variant,
            parts: [{ type: "text", text: payload }],
        });
    }
    catch (err) {
        removeManagementTurn(state, pendingManagementTurnId);
        await saveSessionState(state, logger);
        logger.error("Manage command failed", { error: err?.message });
        await sendManageFailureFeedback(client, logger, sessionId, `Compression management could not start: ${err?.message || "the prompt failed."}`, currentParams);
        return;
    }
    const triggerMessageId = extractPromptTriggerMessageId(promptResult);
    if (!triggerMessageId) {
        removeManagementTurn(state, pendingManagementTurnId);
        await saveSessionState(state, logger);
        logger.error("Manage command could not capture generated message ID", { sessionId });
        await sendManageFailureFeedback(client, logger, sessionId, "Compression management started, but cleanup bookkeeping could not identify the message ID.", currentParams);
        return;
    }
    finalizeManagementTurnId(state, pendingManagementTurnId, triggerMessageId);
    const finalStatePersisted = await saveSessionState(state, logger);
    if (!finalStatePersisted) {
        logger.error("Manage command cleanup state could not be finalized", { sessionId, triggerMessageId });
        await sendManageFailureFeedback(client, logger, sessionId, "Compression management started, but cleanup bookkeeping could not be saved. Cleanup may not survive restart.", currentParams);
        return;
    }
    logger.info("Manage command: sent compression context to agent", { sessionId, triggerMessageId });
}
//# sourceMappingURL=manage.js.map