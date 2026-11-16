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
    lines.push("- `/compress off`, `/compress on`, `/compress status` — Stop, resume, or show automatic fold requests for this session");
    lines.push("- `/compress threshold [N|reset]` — Show or set this session's fold threshold in tokens; `reset` returns to the config value");
    lines.push("- `/compress help` — Show this command list");
    return lines.join("\n");
}
export async function handleHelpCommand(ctx) {
    const { client, logger, sessionId } = ctx;
    const message = formatHelpMessage();
    await sendIgnoredMessage(client, sessionId, message, logger);
}
//# sourceMappingURL=help.js.map