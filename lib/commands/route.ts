import type { PluginConfig } from "../config.js"
import type { Logger } from "../logger.js"
import { listSessionMessages, type PluginClient } from "../sdk/client.js"
import {
    reconcileSessionLifecycle,
    type SessionStateManager,
    type WithParts,
} from "../state/index.js"
import { handleAutoCommand } from "./auto.js"
import { handleContextCommand } from "./context.js"
import { handleHelpCommand } from "./help.js"
import { handleManageCommand } from "./manage.js"
import { handleSquashCommand } from "./squash.js"
import { handleStatsCommand } from "./stats.js"

export async function handleCompressCommand(
    input: { command: string; sessionID: string; arguments: string },
    dependencies: {
        client: PluginClient
        stateManager: SessionStateManager
        logger: Logger
        config: PluginConfig
    },
): Promise<boolean> {
    if (!dependencies.config.commands.enabled || input.command !== "compress") return false

    const { client, stateManager, logger, config } = dependencies
    const state = stateManager.get(input.sessionID)
    const messages = await stateManager.runExclusive(input.sessionID, async () => {
        const currentMessages = (await listSessionMessages(client, input.sessionID)) as WithParts[]
        await reconcileSessionLifecycle(state, input.sessionID, logger, currentMessages)
        return currentMessages
    })
    const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
    const subcommand = args[0]?.toLowerCase() || ""

    if (subcommand === "context") {
        await handleContextCommand({ client, state, logger, sessionId: input.sessionID, messages })
        return true
    }
    if (subcommand === "stats") {
        await handleStatsCommand({ client, state, logger, sessionId: input.sessionID, messages })
        return true
    }
    if (subcommand === "manage") {
        await handleManageCommand({
            client,
            stateManager,
            state,
            config,
            logger,
            sessionId: input.sessionID,
            messages,
            arguments: input.arguments,
        })
        return true
    }
    if (subcommand === "squash") {
        await handleSquashCommand({
            client,
            stateManager,
            state,
            config,
            logger,
            sessionId: input.sessionID,
            messages,
            arguments: input.arguments,
        })
        return true
    }
    if (subcommand === "auto") {
        await handleAutoCommand({
            client,
            stateManager,
            state,
            config,
            logger,
            sessionId: input.sessionID,
            messages,
            arguments: args.slice(1),
        })
        return true
    }

    await handleHelpCommand({ client, state, logger, sessionId: input.sessionID, messages })
    return true
}
