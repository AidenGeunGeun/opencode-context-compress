import type { PluginConfig } from "./config.js"
import type { Logger } from "./logger.js"
import {
    stageManagementTurnWithinLock,
    type StagedManagementTurn,
} from "./commands/manage.js"
import { findActiveManagementTurn } from "./messages/compress-transform.js"
import { renderAutomaticSystemPrompt } from "./prompts/index.js"
import { listSessionMessages, showToast } from "./sdk/client.js"
import { reconcileSessionLifecycle, SessionStateManager, type WithParts } from "./state/index.js"
import { sendIgnoredMessage } from "./ui/notification.js"
import {
    isMessageWithinPostCompressionCooldown,
    messageContainsCompressCall,
    resolveEffectiveAutoCompressionPolicy,
} from "./auto-policy.js"

export interface AssistantUsage {
    total?: number
    input?: number
    output?: number
    reasoning?: number
    cache?: {
        read?: number
        write?: number
    }
}

export interface AssistantMessageInfo {
    id: string
    sessionID: string
    role: "assistant"
    agent?: string
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
    acceptsSession: (sessionID: string, event: unknown) => Promise<boolean> = async () => true,
) {
    const started = new Map<
        string,
        { sessionID: string; agent?: string; providerID?: string; modelID?: string }
    >()
    return async (input: unknown) => {
        const outer = isRecord(input) && isRecord(input.event) ? input.event : input
        const event = isRecord(outer) ? outer : {}
        const data = isRecord(event.data) ? event.data : {}
        if (event.type === "session.step.started") {
            const model = isRecord(data.model) ? data.model : {}
            if (typeof data.assistantMessageID === "string" && typeof data.sessionID === "string") {
                started.set(data.assistantMessageID, {
                    sessionID: data.sessionID,
                    agent: typeof data.agent === "string" ? data.agent : undefined,
                    providerID: typeof model.providerID === "string" ? model.providerID : undefined,
                    modelID: typeof model.id === "string" ? model.id : undefined,
                })
            }
            return
        }
        const projected =
            event.type === "session.step.ended" && typeof data.assistantMessageID === "string"
                ? started.get(data.assistantMessageID)
                : undefined
        if (event.type === "session.step.failed") {
            if (typeof data.assistantMessageID === "string") started.delete(data.assistantMessageID)
            return
        }
        if (event.type === "session.step.ended" && typeof data.assistantMessageID === "string") {
            started.delete(data.assistantMessageID)
        }
        const info: AssistantMessageInfo | undefined = projected
            ? {
                  id: data.assistantMessageID as string,
                  sessionID: projected.sessionID,
                  role: "assistant",
                  agent: projected.agent,
                  providerID: projected.providerID,
                  modelID: projected.modelID,
                  time: { completed: Date.now() },
                  tokens: isRecord(data.tokens) ? (data.tokens as AssistantUsage) : undefined,
              }
            : event.type === "session.step.ended" &&
                typeof data.assistantMessageID === "string" &&
                typeof data.sessionID === "string"
              ? {
                    id: data.assistantMessageID,
                    sessionID: data.sessionID,
                    role: "assistant",
                    time: { completed: Date.now() },
                    tokens: isRecord(data.tokens) ? (data.tokens as AssistantUsage) : undefined,
                }
            : isRecord(event.properties) && isRecord(event.properties.info)
              ? (event.properties.info as unknown as AssistantMessageInfo)
              : undefined
        if (
            !config.autoCompression.enabled ||
            config.tools.compress.permission === "deny"
        ) return
        if (event.type !== "message.updated" && event.type !== "session.step.ended") return
        if (
            !info ||
            info.role !== "assistant" ||
            info.summary === true ||
            info.error ||
            !info.time?.completed
        ) {
            return
        }

        if (!(await acceptsSession(info.sessionID, outer))) return

        const state = stateManager.get(info.sessionID)
        const contextTokens = getAssistantContextTokens(info.tokens)
        if (state.initialized && state.persistenceSynchronized) {
            const policy = resolveEffectiveAutoCompressionPolicy(config.autoCompression, state)
            const threshold = resolveAutomaticCompressionThreshold(
                contextTokens,
                policy,
                findContextLimit(stateManager, info),
            )

            // Cooldown progress is derived from the transcript when it is next needed, so
            // skipping a transcript read here cannot lose responses or double-count events.
            if (
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

                await reconcileSessionLifecycle(state, info.sessionID, logger, messages)
                if (!state.persistenceSynchronized) {
                    logger.warn("Automatic compression skipped because session policy could not be loaded", {
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
                    cooldownApplies
                ) {
                    return undefined
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

                const staged = await stageManagementTurnWithinLock({
                    client,
                    stateManager,
                    state,
                    logger,
                    sessionId: info.sessionID,
                    messages,
                    systemPrompt: renderAutomaticSystemPrompt({
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
                    protectedTurns: config.protectedTurns,
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
            const shown = await showToast(client, {
                title: "Automatic Compression",
                message: `Could not start automatic compression: ${message}`,
                variant: "error",
                duration: 8000,
            })
            if (!shown) {
                await sendIgnoredMessage(
                    client,
                    info.sessionID,
                    `Could not start automatic compression: ${message}`,
                    {
                        agent: info.agent,
                        providerId: info.providerID,
                        modelId: info.modelID,
                        variant: state.variant,
                    },
                    logger,
                )
            }
        } finally {
            if (attemptedStart) {
                state.autoCompressionStarting = false
            }
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
