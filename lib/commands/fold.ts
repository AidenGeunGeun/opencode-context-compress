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

/** Turns automatic fold requests on or off for one session, or shows which applies. */
export async function handleFoldCommand(ctx: {
    client: PluginClient
    stateManager: SessionStateManager
    state: SessionState
    logger: Logger
    sessionId: string
    action: string
}): Promise<void> {
    const response = await ctx.stateManager.runExclusive(ctx.sessionId, async () => {
        const messages = await listSessionMessages(ctx.client, ctx.sessionId)
        await reconcileSessionLifecycle(ctx.state, ctx.sessionId, ctx.logger, messages)
        if (!ctx.state.persistenceSynchronized)
            return "Fold settings are unavailable because saved session state could not be loaded. Nothing was changed."
        const off = ctx.state.foldOff === true
        if (ctx.action === "status")
            return `Automatic fold requests are ${off ? "off" : "on"} for this session.`
        if ((ctx.action === "off") === off)
            return `Automatic fold requests are already ${ctx.action} for this session.`
        const candidate: SessionState = {
            ...ctx.state,
            foldOff: ctx.action === "off" ? true : undefined,
        }
        if (!(await saveSessionState(candidate, ctx.logger)))
            return "Fold settings could not be saved. Nothing was changed."
        commitDurableSessionState(ctx.state, candidate)
        return ctx.action === "off"
            ? "Automatic fold requests are off for this session. `/compress manage` still folds on demand."
            : "Automatic fold requests are on for this session."
    })
    await sendIgnoredMessage(ctx.client, ctx.sessionId, response, ctx.logger)
}
