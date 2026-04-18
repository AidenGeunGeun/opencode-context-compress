import { tool } from "@opencode-ai/plugin"

import { loadPrompt } from "../prompts"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { getCurrentParams } from "../token-utils"
import { buildContextMap } from "../messages/context-map"
import type { CompressToolContext } from "./types"

const COMPRESS_MAP_TOOL_DESCRIPTION = loadPrompt("compress-map-tool-spec")

export function createCompressMapTool(ctx: CompressToolContext): ReturnType<typeof tool> {
    return tool({
        description: COMPRESS_MAP_TOOL_DESCRIPTION,
        args: {},
        async execute(_args, toolCtx) {
            const { client, stateManager, logger } = ctx
            const sessionId = toolCtx.sessionID
            const state = stateManager.get(sessionId)

            await toolCtx.ask({
                permission: "compress_map",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

            const messagesResponse = await client.session.messages({
                path: { id: sessionId },
            })
            const rawMessages = messagesResponse.data || messagesResponse

            await ensureSessionInitialized(client, state, sessionId, logger, rawMessages)

            const currentParams = getCurrentParams(state, rawMessages, logger)
            const contextMap = buildContextMap(rawMessages, state, logger, currentParams.providerId)

            try {
                await saveSessionState(state, logger)
            } catch (err: any) {
                logger.error("Failed to persist state", { error: err.message })
            }

            return contextMap.mapText
        },
    })
}
