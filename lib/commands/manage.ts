import { createHash } from "node:crypto"
import type { Logger } from "../logger.js"
import type { ManagementTurn, SessionState, WithParts } from "../state/index.js"
import type { SessionStateManager } from "../state/state.js"
import { commitDurableSessionState } from "../state/state.js"
import type { PluginConfig } from "../config.js"
import { renderSystemPrompt } from "../prompts/index.js"
import { saveSessionState } from "../state/persistence.js"
import { sendIgnoredMessage } from "../ui/notification.js"
import { deriveAutomaticProtectedTail } from "../messages/context-map.js"
import { isRecord } from "../shared-utils.js"
import { type PluginClient, promptSession } from "../sdk/client.js"

export interface ManageCommandContext {
    client: PluginClient
    stateManager: SessionStateManager
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    arguments?: string
}

export interface ManagementTurnStartContext {
    client: PluginClient
    stateManager: SessionStateManager
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    systemPrompt: string
    retainedText?: string
    source?: "automatic" | "squash"
    triggeredByMessageId?: string
    contextTokens?: number
    thresholdTokens?: number
    protectedTurns?: number
    asyncPrompt?: boolean
}

export type StagedManagementTurn = () => Promise<boolean>

const COMPRESSION_ONLY_TEXT =
    /^(?:(?:please|pls|kindly|can you|could you|would you|now|thanks|thank you|context|conversation|history|manage|management|compress|compression|compact|cleanup|clean|up|prune|summari[sz]e|old|older|completed|past|previous|messages|turns|work|range|ranges|blocks?|cache|the|my|this|that|our|session|for|to|and|all|some|a|an|it|do|run|just)[\s,.;:!?-]*)+$/i
const LEADING_COMPRESSION_REQUEST =
    /^\s*(?:(?:please|pls|kindly)\s+)?(?:compress|manage|compact|clean\s+up|cleanup|prune|summari[sz]e)(?:\s+(?:the|this|that|our|my|old|older|past|previous|completed|conversation|context|history|messages|turns|work|session|blocks?|ranges?))*\s*(?:now|please)?\s*(?:[:;,.!-]+\s*)/i
const LEADING_COMPRESSION_REQUEST_WITH_CONJUNCTION =
    /^\s*(?:(?:please|pls|kindly)\s+)?(?:compress|manage|compact|clean\s+up|cleanup|prune|summari[sz]e)(?:\s+(?:the|this|that|our|my|old|older|past|previous|completed|conversation|context|history|messages|turns|work|session|blocks?|ranges?))*\s+(?:and|also|but)\b\s*/i

function trimCommandBoundary(text: string): string {
    return text.replace(/^[\s:;,.|-]+/, "").replace(/\s+$/, "")
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

function generateLiveOrderedMessageIdSuffix(timestamp = Date.now(), identity?: string): string {
    if (!identity) {
        if (timestamp !== lastGeneratedMessageIdTimestamp) {
            lastGeneratedMessageIdTimestamp = timestamp
            lastGeneratedMessageIdCounter = 0
        }
        lastGeneratedMessageIdCounter++
    }

    const current =
        BigInt(timestamp) * 0x1000n + BigInt(identity ? 0 : lastGeneratedMessageIdCounter)
    const value = ~current
    const time = Array.from({ length: 6 }, (_, index) =>
        Number((value >> BigInt(40 - 8 * index)) & 0xffn)
            .toString(16)
            .padStart(2, "0"),
    ).join("")
    const random = identity
        ? createHash("sha256").update(identity).digest("hex").slice(0, 14)
        : Array.from(
              { length: 14 },
              () =>
                  ASCENDING_ID_RANDOM_CHARS[
                      Math.floor(Math.random() * ASCENDING_ID_RANDOM_CHARS.length)
                  ],
          ).join("")
    return time + random
}

export function generateManagePromptMessageId(): string {
    return `msg_${generateLiveOrderedMessageIdSuffix()}`
}

export function generateNativeCompactionNoticeId(
    sessionId: string,
    event: Record<string, unknown>,
): string | undefined {
    if (typeof event.id !== "string" || typeof event.created !== "number") return undefined
    return `msg_${generateLiveOrderedMessageIdSuffix(
        Math.floor(event.created),
        JSON.stringify(["native-auto-compaction", sessionId, event.id]),
    )}`
}

export function generateAutomaticPromptMessageId(
    sessionId: string,
    trigger: WithParts["info"],
): string {
    // The host deduplicates prompt admission by ID, including across plugin instances.
    return `msg_${generateLiveOrderedMessageIdSuffix(
        trigger.time.completed ?? trigger.time.created,
        JSON.stringify(["automatic-compression", sessionId, trigger.id]),
    )}`
}

export async function handleManageCommand(ctx: ManageCommandContext): Promise<void> {
    if (ctx.config.tools.compress.permission === "deny") {
        await sendIgnoredMessage(
            ctx.client,
            ctx.sessionId,
            "Compression management did not start because compress is denied. Enable the compression tool, then run `/compress manage` again.",
            ctx.logger,
        )
        return
    }

    await startManagementTurn({
        client: ctx.client,
        stateManager: ctx.stateManager,
        state: ctx.state,
        logger: ctx.logger,
        sessionId: ctx.sessionId,
        messages: ctx.messages,
        systemPrompt: renderSystemPrompt(),
        retainedText: extractManageCommandResidual(ctx.arguments),
    })
}

/** Persists the turn marker; the caller must hold this session's mutation lock. */
export async function stageManagementTurnWithinLock(
    ctx: ManagementTurnStartContext,
): Promise<StagedManagementTurn | undefined> {
    const { client, stateManager, state, logger, sessionId, messages } = ctx

    if (!state.persistenceSynchronized) {
        return async () => {
            await sendIgnoredMessage(
                client,
                sessionId,
                "Compression management could not start because saved session state could not be loaded.",
                logger,
            )
            return false
        }
    }

    const automaticTail =
        ctx.source === "automatic"
            ? deriveAutomaticProtectedTail(messages, state, logger, ctx.protectedTurns ?? 0)
            : undefined

    if (ctx.source === "automatic" && !automaticTail?.hasSelectableMessages) {
        logger.warn(
            "Automatic compression skipped because the protected tail covers all selectable messages",
            {
                sessionId,
                protectedTurns: ctx.protectedTurns ?? 0,
            },
        )
        return undefined
    }

    const messageParts: Array<Record<string, unknown>> = []

    if (ctx.systemPrompt) {
        messageParts.push({ type: "text", text: ctx.systemPrompt })
    }
    if (ctx.retainedText) {
        messageParts.push({
            type: "text",
            text: ["<user-message>", ctx.retainedText, "</user-message>"].join("\n"),
        })
    }

    const trigger =
        ctx.source === "automatic"
            ? messages.find((message) => message.info.id === ctx.triggeredByMessageId)
            : undefined
    if (ctx.source === "automatic" && !trigger) {
        throw new Error("Automatic compression trigger is missing from projected history")
    }
    const triggerMessageId = trigger
        ? generateAutomaticPromptMessageId(sessionId, trigger.info)
        : generateManagePromptMessageId()
    const managementTurn: ManagementTurn = {
        triggerMessageId,
        cleanupVersion: 2,
        ...(ctx.retainedText ? { retainedText: ctx.retainedText } : {}),
        ...(ctx.source ? { source: ctx.source } : {}),
        ...(ctx.triggeredByMessageId ? { triggeredByMessageId: ctx.triggeredByMessageId } : {}),
        ...(typeof ctx.contextTokens === "number" ? { contextTokens: ctx.contextTokens } : {}),
        ...(typeof ctx.thresholdTokens === "number"
            ? { thresholdTokens: ctx.thresholdTokens }
            : {}),
    }
    const candidateState: SessionState = {
        ...state,
        managementTurns: [...state.managementTurns, managementTurn],
        compressionMapSnapshot: undefined,
    }
    const statePersisted = await saveSessionState(candidateState, logger)
    if (!statePersisted) {
        logger.error("Manage command aborted because cleanup state could not be persisted", {
            sessionId,
            triggerMessageId,
        })
        return async () => {
            await sendIgnoredMessage(
                client,
                sessionId,
                "Compression management could not start: cleanup state could not be saved.",
                logger,
            )
            return false
        }
    }
    commitDurableSessionState(state, candidateState)

    return async () => {
        try {
            await promptSession(client, {
                sessionId,
                parts: messageParts,
                messageId: triggerMessageId,
                metadata: { "opencode.context-compress.management": true },
            })
        } catch (err) {
            const errorMessage =
                isRecord(err) && typeof err.message === "string" ? err.message : undefined
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
            logger.error("Manage command failed", { error: errorMessage })
            if (rollbackResult === "completed") {
                logger.warn(
                    "Manage prompt failed after compression completed; preserving the completed turn marker",
                    {
                        sessionId,
                        triggerMessageId,
                    },
                )
            } else if (rollbackResult === "failed") {
                logger.error("Manage prompt failure marker could not be rolled back", {
                    sessionId,
                    triggerMessageId,
                })
            }
            await sendIgnoredMessage(
                client,
                sessionId,
                rollbackResult === "completed"
                    ? `The compression management prompt reported an error after compression completed: ${errorMessage || "the prompt failed."} The completed state was preserved.`
                    : rollbackResult === "removed"
                      ? `Compression management could not start: ${errorMessage || "the prompt failed."}`
                      : `Compression management could not start: ${errorMessage || "the prompt failed."} Its saved cleanup marker could not be removed.`,
                logger,
            )
            return false
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
