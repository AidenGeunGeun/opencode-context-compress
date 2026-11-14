import type { PluginConfig } from "../config.js"
import { foldThreshold } from "../fold-request.js"
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

const THRESHOLD_USAGE =
    "Usage: `/compress threshold [N|reset]`, where N is a whole number of tokens above zero."

/** Shows or sets the token limit at which this session gets its first fold request. */
export async function handleThresholdCommand(ctx: {
    client: PluginClient
    stateManager: SessionStateManager
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    arguments: string[]
}): Promise<void> {
    const action = ctx.arguments.length <= 1 ? (ctx.arguments[0]?.toLowerCase() ?? "status") : ""
    const value = /^[0-9]+$/.test(action) ? Number(action) : 0
    const response =
        action === "status" || action === "reset" || (Number.isSafeInteger(value) && value > 0)
            ? await ctx.stateManager.runExclusive(ctx.sessionId, async () => {
                  const messages = await listSessionMessages(ctx.client, ctx.sessionId)
                  await reconcileSessionLifecycle(ctx.state, ctx.sessionId, ctx.logger, messages)
                  if (action !== "status") {
                      if (!ctx.state.persistenceSynchronized)
                          return "The threshold is unavailable because saved session state could not be loaded. Nothing was changed."
                      const candidate: SessionState = {
                          ...ctx.state,
                          tokenThreshold: action === "reset" ? undefined : value,
                      }
                      if (!(await saveSessionState(candidate, ctx.logger)))
                          return "The threshold could not be saved. Nothing was changed."
                      commitDurableSessionState(ctx.state, candidate)
                  }
                  const threshold = foldThreshold(ctx.config, ctx.state)
                  return `The fold threshold for this session is ~${threshold.tokens.toLocaleString("en-US")} tokens (${threshold.basis}).`
              })
            : THRESHOLD_USAGE
    await sendIgnoredMessage(ctx.client, ctx.sessionId, response, ctx.logger)
}
