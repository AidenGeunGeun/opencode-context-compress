import type { Logger } from "../logger.js"
import type { PluginConfig } from "../config.js"
import type { SessionState, WithParts } from "../state/index.js"
import type { SessionStateManager } from "../state/state.js"
import { findActiveManagementTurn } from "../messages/compress-transform.js"
import { orderCompressBlocks } from "../messages/blocks.js"
import { renderSquashSystemPrompt } from "../prompts/index.js"
import { getCurrentParams } from "../token-utils.js"
import {
    sendManageFailureFeedback,
    stageManagementTurnWithinLock,
    type StagedManagementTurn,
} from "./manage.js"

export interface SquashCommandContext {
    client: any
    stateManager: SessionStateManager
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    arguments?: string
}

export function extractSquashCommandResidual(args: string | undefined): string | undefined {
    const residual = (args || "")
        .replace(/^\s*squash\b/i, "")
        .replace(/^[\s:;,.|\-]+/, "")
        .trim()
    return residual || undefined
}

export async function handleSquashCommand(ctx: SquashCommandContext): Promise<void> {
    const currentParams = getCurrentParams(ctx.state, ctx.messages, ctx.logger)
    if (ctx.config.tools.compress.permission === "deny") {
        await sendManageFailureFeedback(
            ctx.client,
            ctx.logger,
            ctx.sessionId,
            "Block squash did not start because squash follows the denied compress permission. Enable the compression tool, then run `/compress squash` again.",
            currentParams,
        )
        return
    }

    const staged = await ctx.stateManager.runExclusive(ctx.sessionId, async () => {
        if (!ctx.state.persistenceSynchronized) {
            return async () => {
                await sendManageFailureFeedback(
                    ctx.client,
                    ctx.logger,
                    ctx.sessionId,
                    "Block squash could not start because saved session state could not be loaded.",
                    currentParams,
                )
                return false
            }
        }

        if (findActiveManagementTurn(ctx.state, ctx.messages)) {
            return async () => {
                await sendManageFailureFeedback(
                    ctx.client,
                    ctx.logger,
                    ctx.sessionId,
                    "Block squash could not start because another compression management turn is still active.",
                    currentParams,
                )
                return false
            }
        }

        let blockCount: number
        try {
            blockCount = orderCompressBlocks(ctx.messages, ctx.state.compressSummaries).length
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return async () => {
                await sendManageFailureFeedback(
                    ctx.client,
                    ctx.logger,
                    ctx.sessionId,
                    `Block squash could not start: ${message}`,
                    currentParams,
                )
                return false
            }
        }
        if (blockCount < 2) {
            return async () => {
                await sendManageFailureFeedback(
                    ctx.client,
                    ctx.logger,
                    ctx.sessionId,
                    "Block squash requires at least two existing compressed blocks.",
                    currentParams,
                )
                return false
            }
        }

        return stageManagementTurnWithinLock({
            ...ctx,
            systemPrompt: renderSquashSystemPrompt(),
            retainedText: extractSquashCommandResidual(ctx.arguments),
            source: "squash",
        })
    }) as StagedManagementTurn | undefined

    if (staged) await staged()
}
