import type { Logger } from "../logger.js"
import type { SessionState, WithParts } from "../state/index.js"
import type { PluginConfig } from "../config.js"
import { renderSystemPrompt } from "../prompts/index.js"
import { getCurrentParams } from "../token-utils.js"
import { syncToolCache } from "../state/tool-cache.js"
import { saveSessionState } from "../state/persistence.js"
import { sendIgnoredMessage } from "../ui/notification.js"
import { buildContextMap } from "../messages/context-map.js"
import { ulid } from "ulid"
import { promptSession, showToast } from "../sdk/client.js"

export interface ManageCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    arguments?: string
}

const COMPRESSION_ONLY_TEXT = /^(?:(?:please|pls|kindly|can you|could you|would you|now|thanks|thank you|context|conversation|history|manage|management|compress|compression|compact|cleanup|clean|up|prune|summari[sz]e|old|older|completed|past|previous|messages|turns|work|range|ranges|blocks?|cache|the|my|this|that|our|session|for|to|and|all|some|a|an|it|do|run|just)[\s,.;:!?-]*)+$/i
const LEADING_COMPRESSION_REQUEST = /^\s*(?:(?:please|pls|kindly)\s+)?(?:compress|manage|compact|clean\s+up|cleanup|prune|summari[sz]e)(?:\s+(?:the|this|that|our|my|old|older|past|previous|completed|conversation|context|history|messages|turns|work|session|blocks?|ranges?))*\s*(?:now|please)?\s*(?:[:;,.!-]+\s*)/i
const LEADING_COMPRESSION_REQUEST_WITH_CONJUNCTION = /^\s*(?:(?:please|pls|kindly)\s+)?(?:compress|manage|compact|clean\s+up|cleanup|prune|summari[sz]e)(?:\s+(?:the|this|that|our|my|old|older|past|previous|completed|conversation|context|history|messages|turns|work|session|blocks?|ranges?))*\s+(?:and|also|but)\b\s*/i

function trimCommandBoundary(text: string): string {
    return text.replace(/^[\s:;,.|\-]+/, "").replace(/\s+$/, "")
}

export function extractManageCommandResidual(args: string | undefined): string | undefined {
    const withoutSubcommand = (args || "").replace(/^\s*manage\b/i, "")
    const initial = trimCommandBoundary(withoutSubcommand)
    if (!initial) {
        return undefined
    }

    let residual = initial
    const stripped = residual
        .replace(LEADING_COMPRESSION_REQUEST, "")
        .replace(LEADING_COMPRESSION_REQUEST_WITH_CONJUNCTION, "")
    if (stripped !== residual) {
        residual = stripped.replace(/^\s*(?:and|also|but)\b[\s,]*/i, "")
    }

    residual = trimCommandBoundary(residual)
    if (!residual || COMPRESSION_ONLY_TEXT.test(residual)) {
        return undefined
    }

    return residual
}

function generateManagePromptMessageId(): string {
    return `msg_${ulid()}`
}

function removeManagementTurn(state: SessionState, triggerMessageId: string): void {
    state.managementTurns = state.managementTurns.filter((turn) => turn.triggerMessageId !== triggerMessageId)
}

/**
 * Best-effort sanity check only. The generated trigger ID passed via `messageID` on the
 * prompt call is the source of truth for cleanup anchoring - the assistant response's
 * `parentID` is not trusted, since OpenCode can bind it to whatever user message was most
 * recently created in the session (e.g. a mid-turn ignored status notification), not
 * necessarily the message that actually started this turn.
 */
function extractPromptParentIdForLogging(promptResult: any): string | undefined {
    const result = promptResult?.data ?? promptResult
    const info = result?.info
    if (!info || typeof info !== "object") {
        return undefined
    }

    return typeof info.parentID === "string" && info.parentID.length > 0 ? info.parentID : undefined
}

async function sendManageFailureFeedback(
    client: any,
    logger: Logger,
    sessionId: string,
    message: string,
    params: any,
): Promise<void> {
    if (await showToast(client, {
        title: "Compression Management",
        message,
        variant: "error",
        duration: 8000,
    })) {
        return
    }

    if (typeof client?.session?.prompt === "function") {
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return
    }

    logger.error("Unable to surface compression management error to user", { sessionId, message })
}

export async function handleManageCommand(ctx: ManageCommandContext): Promise<void> {
    const { client, state, config, logger, sessionId, messages } = ctx

    await syncToolCache(state, config, logger, messages)

    const flags = {
        compress: config.tools.compress.permission !== "deny",
        compress_map: config.tools.compress_map.permission !== "deny",
    }

    const currentParams = getCurrentParams(state, messages, logger)

    // Built from the pre-management conversation only, before the trigger message or
    // anything else about this turn exists - the agent gets the map it needs up front and
    // normally never has to call `compress_map` itself.
    const contextMap = buildContextMap(messages, state, logger, currentParams.providerId)

    const messageParts: Array<Record<string, unknown>> = []

    const systemPrompt = renderSystemPrompt(flags)
    if (systemPrompt) {
        messageParts.push({ type: "text", text: systemPrompt })
    }
    messageParts.push({ type: "text", text: contextMap.mapText })

    const retainedText = extractManageCommandResidual(ctx.arguments)
    if (retainedText) {
        messageParts.push({
            type: "text",
            text: ["<user-message>", retainedText, "</user-message>"].join("\n"),
        })
    }

    const triggerMessageId = generateManagePromptMessageId()
    state.managementTurns.push({
        triggerMessageId,
        ...(retainedText ? { retainedText } : {}),
    })

    const statePersisted = await saveSessionState(state, logger)
    if (!statePersisted) {
        removeManagementTurn(state, triggerMessageId)
        logger.error("Manage command aborted because cleanup state could not be persisted", {
            sessionId,
            triggerMessageId,
        })
        await sendManageFailureFeedback(
            client,
            logger,
            sessionId,
            "Compression management could not start: cleanup state could not be saved.",
            currentParams,
        )
        return
    }

    const model =
        currentParams.providerId && currentParams.modelId
            ? {
                  providerID: currentParams.providerId,
                  modelID: currentParams.modelId,
              }
            : undefined

    let promptResult: any
    try {
        promptResult = await promptSession(client, {
            sessionId,
            agent: currentParams.agent,
            model,
            variant: currentParams.variant,
            parts: messageParts,
            messageId: triggerMessageId,
        })
    } catch (err: any) {
        removeManagementTurn(state, triggerMessageId)
        await saveSessionState(state, logger)
        logger.error("Manage command failed", { error: err?.message })
        await sendManageFailureFeedback(
            client,
            logger,
            sessionId,
            `Compression management could not start: ${err?.message || "the prompt failed."}`,
            currentParams,
        )
        return
    }

    const returnedParentId = extractPromptParentIdForLogging(promptResult)
    if (returnedParentId && returnedParentId !== triggerMessageId) {
        logger.warn("Manage prompt result parentID differs from the generated trigger ID; keeping the generated ID as the cleanup anchor", {
            sessionId,
            triggerMessageId,
            returnedParentId,
        })
    }

    logger.info("Manage command: sent compression context to agent", { sessionId, triggerMessageId })
}
