import type { Logger } from "../logger.js"
import { listSessionMessages, type PluginClient } from "../sdk/client.js"
import type { SessionState } from "../state/index.js"
import {
    commitDurableSessionState,
    reconcileSessionLifecycle,
    type SessionStateManager,
} from "../state/state.js"
import { saveSessionState } from "../state/persistence.js"
import { sendIgnoredMessage } from "../ui/notification.js"

const PRUNE_USAGE = "Usage: `/compress prune [status|on|off]`"

/**
 * Turns background pruning on or off for one session. Off stops new prunes only: outputs already pruned
 * stay pruned, because restoring them would rewrite the prompt cache and grow the context at once.
 */
export async function handlePruneCommand(ctx: {
    client: PluginClient
    stateManager: SessionStateManager
    state: SessionState
    logger: Logger
    sessionId: string
    arguments: string[]
}): Promise<void> {
    const action = ctx.arguments.length <= 1 ? (ctx.arguments[0]?.toLowerCase() ?? "status") : ""
    const response = ["status", "on", "off"].includes(action)
        ? await ctx.stateManager.runExclusive(ctx.sessionId, async () => {
              const messages = await listSessionMessages(ctx.client, ctx.sessionId)
              await reconcileSessionLifecycle(ctx.state, ctx.sessionId, ctx.logger, messages)
              if (!ctx.state.persistenceSynchronized)
                  return "Pruning settings are unavailable because saved session state could not be loaded. Nothing was changed."
              const off = ctx.state.pruneOff === true
              if (action === "status")
                  return `Background pruning is ${off ? "off" : "on"} for this session.`
              if ((action === "off") === off)
                  return `Background pruning is already ${action} for this session.`
              const candidate: SessionState = {
                  ...ctx.state,
                  pruneOff: action === "off" ? true : undefined,
              }
              if (!(await saveSessionState(candidate, ctx.logger)))
                  return "Pruning settings could not be saved. Nothing was changed."
              commitDurableSessionState(ctx.state, candidate)
              return action === "off"
                  ? "Background pruning is off for this session. Outputs pruned so far stay pruned."
                  : "Background pruning is on for this session."
          })
        : PRUNE_USAGE
    await sendIgnoredMessage(ctx.client, ctx.sessionId, response, ctx.logger)
}
