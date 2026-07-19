import type { PluginConfig } from "./config.js"
import type { Logger } from "./logger.js"
import {
    stageManagementTurnWithinLock,
    type StagedManagementTurn,
} from "./commands/manage.js"
import { findActiveManagementTurn } from "./messages/compress-transform.js"
import { renderAutomaticSystemPrompt } from "./prompts/index.js"
import { listSessionMessages, showToast } from "./sdk/client.js"
import { getSessionGoal } from "./sdk/client.js"
import { reconcileSessionLifecycle, SessionStateManager, type WithParts } from "./state/index.js"
import {
    isMessageWithinPostCompressionCooldown,
    messageContainsCompressCall,
    resolveEffectiveAutoCompressionPolicy,
} from "./auto-policy.js"
import { isContextOverflowError, renderGoalOverflowRecoveryPrompt } from "./goal.js"

interface AssistantUsage {
    total?: number
    input?: number
    output?: number
    reasoning?: number
    cache?: {
        read?: number
        write?: number
    }
}

interface AssistantMessageInfo {
    id: string
    sessionID: string
    role: "assistant"
    providerID?: string
    modelID?: string
    summary?: boolean
    error?: unknown
    time?: { completed?: number }
    tokens?: AssistantUsage
}

export interface AutomaticCompressionThreshold {
    contextTokens: number
    thresholdTokens: number
    relativeThresholdTokens?: number
    contextLimit?: number
    reason: "context-window-ratio" | "absolute-token-threshold"
}

function positiveFinite(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

export function getAssistantContextTokens(tokens: AssistantUsage | undefined): number {
    if (!tokens) return 0
    const reportedTotal = positiveFinite(tokens.total)
    if (reportedTotal > 0) return reportedTotal

    return (
        positiveFinite(tokens.input) +
        positiveFinite(tokens.output) +
        positiveFinite(tokens.reasoning) +
        positiveFinite(tokens.cache?.read) +
        positiveFinite(tokens.cache?.write)
    )
}

export function resolveAutomaticCompressionThreshold(
    contextTokens: number,
    config: Pick<PluginConfig["autoCompression"], "contextWindowRatio" | "tokenThreshold">,
    contextLimit?: number,
): AutomaticCompressionThreshold {
    const normalizedContextLimit = positiveFinite(contextLimit) || undefined
    const relativeThresholdTokens = normalizedContextLimit
        ? Math.floor(normalizedContextLimit * config.contextWindowRatio)
        : undefined
    const thresholdTokens = relativeThresholdTokens
        ? Math.min(relativeThresholdTokens, config.tokenThreshold)
        : config.tokenThreshold

    return {
        contextTokens,
        thresholdTokens,
        relativeThresholdTokens,
        contextLimit: normalizedContextLimit,
        reason:
            relativeThresholdTokens !== undefined && relativeThresholdTokens <= config.tokenThreshold
                ? "context-window-ratio"
                : "absolute-token-threshold",
    }
}

export function createChatParamsHandler(stateManager: SessionStateManager) {
    return async (input: {
        sessionID: string
        model: {
            id?: string
            modelID?: string
            providerID?: string
            limit?: { context?: number }
        }
    }) => {
        const contextLimit = positiveFinite(input.model.limit?.context)
        const modelId = input.model.id ?? input.model.modelID
        const providerId = input.model.providerID
        if (!contextLimit || !modelId || !providerId) return

        stateManager.get(input.sessionID).modelContext = {
            providerId,
            modelId,
            contextLimit,
        }
    }
}

function findContextLimit(
    stateManager: SessionStateManager,
    info: AssistantMessageInfo,
): number | undefined {
    const cached = stateManager.get(info.sessionID).modelContext
    if (!cached) return undefined
    if (info.providerID && cached.providerId !== info.providerID) return undefined
    if (info.modelID && cached.modelId !== info.modelID) return undefined
    return cached.contextLimit
}

function formatThresholdReason(result: AutomaticCompressionThreshold, ratio: number): string {
    return result.reason === "context-window-ratio"
        ? `${Math.round(ratio * 100)}% of the model-reported context window`
        : "the system-wide absolute token limit"
}

export function createAutomaticCompressionEventHandler(
    client: any,
    stateManager: SessionStateManager,
    logger: Logger,
    config: PluginConfig,
) {
    return async (input: { event?: { type?: string; properties?: { info?: AssistantMessageInfo } } }) => {
        if (
            !config.autoCompression.enabled ||
            config.tools.compress.permission === "deny" ||
            config.tools.compress_map.permission === "deny"
        ) return
        if (input.event?.type !== "message.updated") return

        const info = input.event.properties?.info
        const overflow = isContextOverflowError(info?.error)
        if (
            !info ||
            info.role !== "assistant" ||
            info.summary === true ||
            (info.error && !overflow) ||
            !info.time?.completed
        ) {
            return
        }

        const state = stateManager.get(info.sessionID)
        const contextTokens = getAssistantContextTokens(info.tokens)
        if (!overflow && state.initialized && state.persistenceSynchronized) {
            const policy = resolveEffectiveAutoCompressionPolicy(config.autoCompression, state)
            const threshold = resolveAutomaticCompressionThreshold(
                contextTokens,
                policy,
                findContextLimit(stateManager, info),
            )

            // Cooldown progress is derived from the transcript when it is next needed, so
            // skipping a transcript read here cannot lose responses or double-count events.
            if (
                state.isSubAgent ||
                !policy.enabled ||
                contextTokens < threshold.thresholdTokens ||
                state.autoCompressionStarting ||
                state.lastAutoTriggeredMessageId === info.id
            ) {
                return
            }
        }

        let attemptedStart = false
        let reserved:
            | {
                  staged: StagedManagementTurn
                  threshold: AutomaticCompressionThreshold
                  contextTokens: number
              }
            | undefined

        try {
            reserved = await stateManager.runExclusive(info.sessionID, async () => {
                const messages = (await listSessionMessages(client, info.sessionID)) as WithParts[]
                if (messages.length === 0) {
                    logger.warn("Automatic compression skipped because session messages were unavailable", {
                        sessionId: info.sessionID,
                        messageId: info.id,
                    })
                    return undefined
                }

                await reconcileSessionLifecycle(client, state, info.sessionID, logger, messages)
                if (!state.persistenceSynchronized) {
                    logger.warn("Automatic compression skipped because session policy could not be loaded", {
                        sessionId: info.sessionID,
                    })
                    return undefined
                }
                if (state.isSubAgent) {
                    logger.debug("Automatic compression skipped for subagent session", {
                        sessionId: info.sessionID,
                    })
                    return undefined
                }

                const cooldownApplies = isMessageWithinPostCompressionCooldown(
                    state,
                    messages,
                    info.id,
                )
                const policy = resolveEffectiveAutoCompressionPolicy(
                    config.autoCompression,
                    state,
                )
                if (
                    !policy.enabled ||
                    config.tools.compress.permission === "deny" ||
                    config.tools.compress_map.permission === "deny" ||
                    cooldownApplies
                ) {
                    return undefined
                }

                if (overflow) {
                    if (
                        state.goalOverflowRecovery?.overflowMessageId === info.id ||
                        state.autoCompressionStarting ||
                        state.lastAutoTriggeredMessageId === info.id ||
                        findActiveManagementTurn(state, messages)
                    ) {
                        return undefined
                    }
                    const goal = await getSessionGoal(client, info.sessionID)
                    if (goal === undefined || !goal || goal.status !== "blocked") return undefined

                    state.autoCompressionStarting = true
                    state.lastAutoTriggeredMessageId = info.id
                    attemptedStart = true
                    const threshold = resolveAutomaticCompressionThreshold(
                        contextTokens,
                        policy,
                        findContextLimit(stateManager, info),
                    )
                    const staged = await stageManagementTurnWithinLock({
                        client,
                        stateManager,
                        state,
                        config,
                        logger,
                        sessionId: info.sessionID,
                        messages,
                        systemPrompt: renderGoalOverflowRecoveryPrompt(),
                        source: "automatic",
                        triggeredByMessageId: info.id,
                        contextTokens,
                        thresholdTokens: threshold.thresholdTokens,
                        protectedTurns: config.autoCompression.protectedTurns,
                        asyncPrompt: true,
                        goalOverflowRecovery: {
                            overflowMessageId: info.id,
                            goalID: goal.id,
                            timeUpdated: goal.time.updated,
                        },
                    })
                    return staged ? { staged, threshold, contextTokens } : undefined
                }

                const threshold = resolveAutomaticCompressionThreshold(
                    contextTokens,
                    policy,
                    findContextLimit(stateManager, info),
                )
                if (contextTokens < threshold.thresholdTokens) return undefined

                if (
                    state.autoCompressionStarting ||
                    state.lastAutoTriggeredMessageId === info.id ||
                    state.managementTurns.some(
                        (turn) =>
                            turn.source === "automatic" &&
                            turn.triggeredByMessageId === info.id,
                    ) ||
                    findActiveManagementTurn(state, messages) ||
                    messageContainsCompressCall(
                        messages.find((message) => message.info.id === info.id),
                    )
                ) {
                    return undefined
                }

                state.autoCompressionStarting = true
                state.lastAutoTriggeredMessageId = info.id
                attemptedStart = true

                const flags = {
                    compress: true,
                    compress_map: true,
                }
                const staged = await stageManagementTurnWithinLock({
                    client,
                    stateManager,
                    state,
                    config,
                    logger,
                    sessionId: info.sessionID,
                    messages,
                    systemPrompt: renderAutomaticSystemPrompt(flags, {
                        context_tokens: contextTokens.toLocaleString("en-US"),
                        threshold_tokens: threshold.thresholdTokens.toLocaleString("en-US"),
                        threshold_reason: formatThresholdReason(
                            threshold,
                            policy.contextWindowRatio,
                        ),
                    }),
                    source: "automatic",
                    triggeredByMessageId: info.id,
                    contextTokens,
                    thresholdTokens: threshold.thresholdTokens,
                    protectedTurns: config.autoCompression.protectedTurns,
                    asyncPrompt: true,
                })
                return staged ? { staged, threshold, contextTokens } : undefined
            })

            if (!reserved) return
            const started = await reserved.staged()

            if (started) {
                logger.info("Automatic compression initiated", {
                    sessionId: info.sessionID,
                    messageId: info.id,
                    contextTokens: reserved.contextTokens,
                    thresholdTokens: reserved.threshold.thresholdTokens,
                    reason: reserved.threshold.reason,
                })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Automatic compression failed to start", {
                sessionId: info.sessionID,
                messageId: info.id,
                error: message,
            })
            await showToast(client, {
                title: "Automatic Compression",
                message: `Could not start automatic compression: ${message}`,
                variant: "error",
                duration: 8000,
            })
        } finally {
            if (attemptedStart) {
                state.autoCompressionStarting = false
            }
        }
    }
}
