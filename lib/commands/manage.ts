import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { buildCompressContext } from "../messages"
import { renderSystemPrompt } from "../prompts"
import { getCurrentParams } from "../token-utils"
import { syncToolCache } from "../state/tool-cache"

export interface ManageCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export async function handleManageCommand(ctx: ManageCommandContext): Promise<void> {
    const { client, state, config, logger, sessionId, messages } = ctx

    await syncToolCache(state, config, logger, messages)

    const flags = {
        compress: config.tools.compress.permission !== "deny",
    }

    const parts: string[] = []

    const systemPrompt = renderSystemPrompt(flags)
    if (systemPrompt) {
        parts.push(systemPrompt)
    }

    const currentParams = getCurrentParams(state, messages, logger)

    if (flags.compress) {
        const compressContext = buildCompressContext(state, messages, logger, currentParams.providerId)
        parts.push(compressContext)
    }

    parts.push(`<instruction name="compress_manage_directive">
CONTEXT MANAGEMENT REQUESTED
The user has triggered /compress manage because context is large and expensive. Use compress to replace completed conversation phases with extremely detailed summaries.

After completing context management in this turn, do NOT use any compression tools again until the user explicitly runs /compress manage again.
</instruction>`)

    const payload = parts.join("\n\n")
    const model =
        currentParams.providerId && currentParams.modelId
            ? {
                  providerID: currentParams.providerId,
                  modelID: currentParams.modelId,
              }
            : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionId,
            },
            body: {
                agent: currentParams.agent,
                model,
                variant: currentParams.variant,
                parts: [{ type: "text", text: payload }],
            },
        })
        logger.info("Manage command: sent compression context to agent")
    } catch (err: any) {
        logger.error("Manage command failed", { error: err.message })
    }
}
