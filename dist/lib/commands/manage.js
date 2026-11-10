import { renderFoldRequest } from "../prompts/index.js";
import { promptSession } from "../sdk/client.js";
import { sendIgnoredMessage } from "../ui/notification.js";
/** Sends the fold request now, with any text the user typed after `manage` as their guidance. */
export async function handleManageCommand(ctx) {
    if (ctx.config.tools.compress.permission === "deny") {
        await sendIgnoredMessage(ctx.client, ctx.sessionId, "The fold request was not sent because compress is denied. Enable the compress tool, then run `/compress manage` again.", ctx.logger);
        return;
    }
    const instruction = ctx.arguments
        .trim()
        .replace(/^manage\b/i, "")
        .trim();
    await promptSession(ctx.client, {
        sessionId: ctx.sessionId,
        parts: [
            { type: "text", text: renderFoldRequest("The user ran `/compress manage`.") },
            ...(instruction
                ? [{ type: "text", text: `<user-message>\n${instruction}\n</user-message>` }]
                : []),
        ],
    }).then(() => ctx.logger.info("Fold request sent", { sessionId: ctx.sessionId, source: "manual" }), async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error("Fold request failed", { sessionId: ctx.sessionId, error: message });
        await sendIgnoredMessage(ctx.client, ctx.sessionId, `Could not send the fold request: ${message}`, ctx.logger);
    });
}
//# sourceMappingURL=manage.js.map