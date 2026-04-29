import type { WithParts } from "./state"
import { SessionStateManager } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import { applyCompressTransforms } from "./messages"
import { buildToolIdList } from "./messages/utils"
import { checkSession } from "./state"
import { handleStatsCommand } from "./commands/stats"
import { handleContextCommand } from "./commands/context"
import { handleHelpCommand } from "./commands/help"
import { handleManageCommand } from "./commands/manage"
import { ensureSessionInitialized } from "./state/state"
import { forkSessionState } from "./state/persistence"

export function getLastUserSessionId(messages: WithParts[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === "user") {
            return messages[i].info.sessionID
        }
    }
    return undefined
}

export function createChatMessageTransformHandler(
    client: any,
    stateManager: SessionStateManager,
    logger: Logger,
    config: PluginConfig,
    workingDirectory?: string,
) {
    return async (_input: {}, output: { messages: WithParts[] }) => {
        const sessionId = getLastUserSessionId(output.messages)
        if (!sessionId) return

        const state = stateManager.get(sessionId)
        const syncResult = await checkSession(client, state, logger, output.messages)

        if (state.isSubAgent) return

        const messageIds = new Set(output.messages.map((message) => message.info.id))
        const appliedCompressedMessageCount = Array.from(state.compressed.messageIds).filter((id) =>
            messageIds.has(id),
        ).length
        const appliedSummaryCount = state.compressSummaries.filter((summary) =>
            messageIds.has(summary.anchorMessageId),
        ).length

        logger.info("Resolved compress state for prompt transform", {
            sessionID: sessionId,
            directory: workingDirectory,
            source: syncResult.source,
            lastUpdated: syncResult.lastUpdated,
            compressedMessageCount: appliedCompressedMessageCount,
            summaryCount: appliedSummaryCount,
        })

        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages)
        applyCompressTransforms(state, logger, output.messages)
        await logger.saveContext(sessionId, output.messages)
    }
}

export function createCommandExecuteHandler(
    client: any,
    stateManager: SessionStateManager,
    logger: Logger,
    config: PluginConfig,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        _output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "compress") {
            const state = stateManager.get(input.sessionID)
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = (messagesResponse.data || messagesResponse) as WithParts[]

            await ensureSessionInitialized(client, state, input.sessionID, logger, messages)

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const subcommand = args[0]?.toLowerCase() || ""

            if (subcommand === "context") {
                await handleContextCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                })
                throw new Error("__COMPRESS_CONTEXT_HANDLED__")
            }

            if (subcommand === "stats") {
                await handleStatsCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                })
                throw new Error("__COMPRESS_STATS_HANDLED__")
            }

            if (subcommand === "manage") {
                await handleManageCommand({
                    client,
                    state,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                })
                throw new Error("__COMPRESS_MANAGE_HANDLED__")
            }

            await handleHelpCommand({
                client,
                state,
                logger,
                sessionId: input.sessionID,
                messages,
            })
            throw new Error("__COMPRESS_HELP_HANDLED__")
        }
    }
}

export function createSessionForkHandler(stateManager: SessionStateManager, logger: Logger) {
    return async (input: {
        sourceSessionID: string
        targetSessionID: string
        cutoffMessageID?: string
        messageIDMap: Record<string, string>
        toolIDsByMessageID: Record<string, string[]>
        childSessionIDMap: Record<string, string>
    }) => {
        const result = await forkSessionState(
            {
                sourceSessionId: input.sourceSessionID,
                targetSessionId: input.targetSessionID,
                messageIdMap: input.messageIDMap,
                toolIdsByMessageId: input.toolIDsByMessageID,
            },
            logger,
        )

        if (result.status === "migrated") {
            stateManager.delete(input.targetSessionID)
        }

        logger.info("Handled session fork compression state", {
            sourceSessionID: input.sourceSessionID,
            targetSessionID: input.targetSessionID,
            cutoffMessageID: input.cutoffMessageID,
            childSessions: Object.keys(input.childSessionIDMap || {}).length,
            result,
        })
    }
}
