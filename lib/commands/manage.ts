import type { Logger } from "../logger.js"
import type { ManagementTurn, SessionState, WithParts } from "../state/index.js"
import type { SessionStateManager } from "../state/state.js"
import { commitDurableSessionState } from "../state/state.js"
import type { PluginConfig } from "../config.js"
import { renderSystemPrompt } from "../prompts/index.js"
import { getCurrentParams } from "../token-utils.js"
import { syncToolCache } from "../state/tool-cache.js"
import { saveSessionState } from "../state/persistence.js"
import { sendIgnoredMessage } from "../ui/notification.js"
import { buildContextMap } from "../messages/context-map.js"
import { promptSession, promptSessionAsync, showToast } from "../sdk/client.js"

export interface ManageCommandContext {
    client: any
    stateManager: SessionStateManager
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    arguments?: string
}

export interface ManagementTurnStartContext {
    client: any
    stateManager: SessionStateManager
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    systemPrompt: string
    retainedText?: string
    source?: "automatic"
    triggeredByMessageId?: string
    contextTokens?: number
    thresholdTokens?: number
    protectedTurns?: number
    asyncPrompt?: boolean
}

export type StagedManagementTurn = () => Promise<boolean>

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

const ASCENDING_ID_RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastGeneratedMessageIdTimestamp = 0
let lastGeneratedMessageIdCounter = 0

function generateAscendingMessageIdSuffix(timestamp = Date.now()): string {
    if (timestamp !== lastGeneratedMessageIdTimestamp) {
        lastGeneratedMessageIdTimestamp = timestamp
        lastGeneratedMessageIdCounter = 0
    }
    lastGeneratedMessageIdCounter++

    const current = BigInt(timestamp) * 0x1000n + BigInt(lastGeneratedMessageIdCounter)
    const time = Array.from({ length: 6 }, (_, index) =>
        Number((current >> BigInt(40 - 8 * index)) & 0xffn)
            .toString(16)
            .padStart(2, "0"),
    ).join("")
    const random = Array.from({ length: 14 }, () =>
        ASCENDING_ID_RANDOM_CHARS[Math.floor(Math.random() * ASCENDING_ID_RANDOM_CHARS.length)],
    ).join("")
    return time + random
}

export function generateManagePromptMessageId(): string {
    return `msg_${generateAscendingMessageIdSuffix()}`
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
    const flags = {
        compress: ctx.config.tools.compress.permission !== "deny",
        compress_map: ctx.config.tools.compress_map.permission !== "deny",
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
    })
}

/** Persists the turn marker; the caller must hold this session's mutation lock. */
export async function stageManagementTurnWithinLock(
    ctx: ManagementTurnStartContext,
): Promise<StagedManagementTurn | undefined> {
    const { client, stateManager, state, config, logger, sessionId, messages } = ctx

    const currentParams = getCurrentParams(state, messages, logger)
    if (!state.persistenceSynchronized) {
        return async () => {
            await sendManageFailureFeedback(
                client,
                logger,
                sessionId,
                "Compression management could not start because saved session state could not be loaded.",
                currentParams,
            )
            return false
        }
    }

    await syncToolCache(state, config, logger, messages)

    // Built from the pre-management conversation only, before the trigger message or
    // anything else about this turn exists - the agent gets the map it needs up front and
    // normally never has to call `compress_map` itself.
    const contextMap = buildContextMap(
        messages,
        state,
        logger,
        currentParams.providerId,
        ctx.source === "automatic" ? { protectedTurns: ctx.protectedTurns ?? 0 } : undefined,
    )

    if (
        ctx.source === "automatic" &&
        !contextMap.entries.some((entry) => entry.kind === "message" && !entry.protected)
    ) {
        logger.warn("Automatic compression skipped because the protected tail covers all selectable messages", {
            sessionId,
            protectedTurns: ctx.protectedTurns ?? 0,
        })
        return undefined
    }

    const messageParts: Array<Record<string, unknown>> = []

    if (ctx.systemPrompt) {
        messageParts.push({ type: "text", text: ctx.systemPrompt })
    }
    messageParts.push({ type: "text", text: contextMap.mapText })

    if (ctx.retainedText) {
        messageParts.push({
            type: "text",
            text: ["<user-message>", ctx.retainedText, "</user-message>"].join("\n"),
        })
    }

    const triggerMessageId = generateManagePromptMessageId()
    const managementTurn: ManagementTurn = {
        triggerMessageId,
        ...(ctx.retainedText ? { retainedText: ctx.retainedText } : {}),
        ...(ctx.source === "automatic" ? { source: "automatic" as const } : {}),
        ...(ctx.triggeredByMessageId ? { triggeredByMessageId: ctx.triggeredByMessageId } : {}),
        ...(ctx.source === "automatic"
            ? { protectedMessageIds: contextMap.protectedMessageIds }
            : {}),
        ...(typeof ctx.contextTokens === "number" ? { contextTokens: ctx.contextTokens } : {}),
        ...(typeof ctx.thresholdTokens === "number" ? { thresholdTokens: ctx.thresholdTokens } : {}),
    }
    const candidateState: SessionState = {
        ...state,
        managementTurns: [...state.managementTurns, managementTurn],
    }
    const statePersisted = await saveSessionState(candidateState, logger)
    if (!statePersisted) {
        logger.error("Manage command aborted because cleanup state could not be persisted", {
            sessionId,
            triggerMessageId,
        })
        return async () => {
            await sendManageFailureFeedback(
                client,
                logger,
                sessionId,
                "Compression management could not start: cleanup state could not be saved.",
                currentParams,
            )
            return false
        }
    }
    commitDurableSessionState(state, candidateState)

    const model =
        currentParams.providerId && currentParams.modelId
            ? {
                  providerID: currentParams.providerId,
                  modelID: currentParams.modelId,
              }
            : undefined

    return async () => {
        let promptResult: any
        try {
            const sendPrompt = ctx.asyncPrompt ? promptSessionAsync : promptSession
            promptResult = await sendPrompt(client, {
                sessionId,
                agent: currentParams.agent,
                model,
                variant: currentParams.variant,
                parts: messageParts,
                messageId: triggerMessageId,
            })
        } catch (err: any) {
            const rollbackResult = await stateManager.runExclusive(sessionId, async () => {
                const currentTurn = state.managementTurns.find(
                    (turn) => turn.triggerMessageId === triggerMessageId,
                )
                if (!currentTurn) return "removed" as const
                if (currentTurn.completedAt) return "completed" as const

                const rollbackState: SessionState = {
                    ...state,
                    managementTurns: state.managementTurns.filter(
                        (turn) => turn.triggerMessageId !== triggerMessageId,
                    ),
                }
                const persisted = await saveSessionState(rollbackState, logger)
                if (!persisted) return "failed" as const

                commitDurableSessionState(state, rollbackState)
                return "removed" as const
            })
            logger.error("Manage command failed", { error: err?.message })
            if (rollbackResult === "completed") {
                logger.warn("Manage prompt failed after compression completed; preserving the completed turn marker", {
                    sessionId,
                    triggerMessageId,
                })
            } else if (rollbackResult === "failed") {
                logger.error("Manage prompt failure marker could not be rolled back", {
                    sessionId,
                    triggerMessageId,
                })
            }
            await sendManageFailureFeedback(
                client,
                logger,
                sessionId,
                rollbackResult === "completed"
                    ? `The compression management prompt reported an error after compression completed: ${err?.message || "the prompt failed."} The completed state was preserved.`
                    : rollbackResult === "removed"
                      ? `Compression management could not start: ${err?.message || "the prompt failed."}`
                      : `Compression management could not start: ${err?.message || "the prompt failed."} Its saved cleanup marker could not be removed.`,
                currentParams,
            )
            return false
        }

        const returnedParentId = extractPromptParentIdForLogging(promptResult)
        if (returnedParentId && returnedParentId !== triggerMessageId) {
            logger.warn("Manage prompt result parentID differs from the generated trigger ID; keeping the generated ID as the cleanup anchor", {
                sessionId,
                triggerMessageId,
                returnedParentId,
            })
        }

        logger.info("Sent compression context to agent", {
            sessionId,
            triggerMessageId,
            source: ctx.source ?? "manual",
        })
        return true
    }
}

export async function startManagementTurn(ctx: ManagementTurnStartContext): Promise<boolean> {
    const staged = await ctx.stateManager.runExclusive(ctx.sessionId, () =>
        stageManagementTurnWithinLock(ctx),
    )
    return staged ? staged() : false
}
