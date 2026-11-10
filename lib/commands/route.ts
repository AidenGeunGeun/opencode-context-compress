import type { PluginConfig } from "../config.js"
import type { Logger } from "../logger.js"
import { listSessionMessages, type PluginClient } from "../sdk/client.js"
import { reconcileSessionLifecycle, type SessionStateManager } from "../state/index.js"
import { handleContextCommand } from "./context.js"
import { handleHelpCommand } from "./help.js"
import { handleManageCommand } from "./manage.js"
import { handlePruneCommand } from "./prune.js"

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
        const currentMessages = await listSessionMessages(client, input.sessionID)
        await reconcileSessionLifecycle(state, input.sessionID, logger, currentMessages)
        return currentMessages
    })
    const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
    const subcommand = args[0]?.toLowerCase() || ""

    if (subcommand === "context") {
        await handleContextCommand({ client, state, logger, sessionId: input.sessionID, messages })
        return true
    }
    if (subcommand === "manage") {
        await handleManageCommand({
            client,
            config,
            logger,
            sessionId: input.sessionID,
            arguments: input.arguments,
        })
        return true
    }

    if (subcommand === "prune") {
        await handlePruneCommand({
            client,
            stateManager,
            state,
            logger,
            sessionId: input.sessionID,
            arguments: args.slice(1),
        })
        return true
    }

    await handleHelpCommand({ client, logger, sessionId: input.sessionID })
    return true
}
