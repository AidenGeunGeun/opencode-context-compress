import type { PluginConfig } from "../config.js"
import type { Logger } from "../logger.js"
import { renderFoldRequest } from "../prompts/index.js"
import { type PluginClient, promptSession } from "../sdk/client.js"
import { sendIgnoredMessage } from "../ui/notification.js"

/** Sends the fold request now, with any text the user typed after `manage` as their guidance. */
export async function handleManageCommand(ctx: {
    client: PluginClient
    config: PluginConfig
    logger: Logger
    sessionId: string
    arguments: string
}): Promise<void> {
    if (ctx.config.tools.compress.permission === "deny") {
        await sendIgnoredMessage(
            ctx.client,
            ctx.sessionId,
            "The fold request was not sent because compress is denied. Enable the compress tool, then run `/compress manage` again.",
            ctx.logger,
        )
        return
    }
    const instruction = ctx.arguments
        .trim()
        .replace(/^manage\b/i, "")
        .trim()
    const session = await ctx.client.session.get({ sessionID: ctx.sessionId })
    await promptSession(ctx.client, {
        sessionId: ctx.sessionId,
        parts: [
            {
                type: "text",
                text: renderFoldRequest(
                    "The user ran `/compress manage`.",
                    session.parentID !== undefined,
                ),
            },
            ...(instruction
                ? [{ type: "text", text: `<user-message>\n${instruction}\n</user-message>` }]
                : []),
        ],
    }).then(
        () => ctx.logger.info("Fold request sent", { sessionId: ctx.sessionId, source: "manual" }),
        async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.error("Fold request failed", { sessionId: ctx.sessionId, error: message })
            await sendIgnoredMessage(
                ctx.client,
                ctx.sessionId,
                `Could not send the fold request: ${message}`,
                ctx.logger,
            )
        },
    )
}
