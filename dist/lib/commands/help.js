/**
 * Compress help command handler.
 * Shows available compression commands and their descriptions.
 */
import { sendIgnoredMessage } from "../ui/notification.js";
function formatHelpMessage() {
    const lines = [];
    lines.push("**Compress commands**");
    lines.push("");
    lines.push("- `/compress context` — Show token usage breakdown for current session");
    lines.push("- `/compress manage [instruction]` — Ask the agent to fold the context now, optionally with your guidance for the summary");
    lines.push("- `/compress prune [status|on|off]` — Pause or resume background pruning for this session; pruned outputs stay pruned");
    lines.push("- `/compress help` — Show this command list");
    return lines.join("\n");
}
export async function handleHelpCommand(ctx) {
    const { client, logger, sessionId } = ctx;
    const message = formatHelpMessage();
    await sendIgnoredMessage(client, sessionId, message, logger);
}
//# sourceMappingURL=help.js.map