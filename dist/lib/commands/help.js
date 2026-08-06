/**
 * Compress help command handler.
 * Shows available compression commands and their descriptions.
 */
import { sendIgnoredMessage } from "../ui/notification.js";
import { getCurrentParams } from "../token-utils.js";
function formatHelpMessage() {
    const lines = [];
    lines.push("**Compress commands**");
    lines.push("");
    lines.push("- `/compress context` — Show token usage breakdown for current session");
    lines.push("- `/compress stats` — Show context compression statistics");
    lines.push("- `/compress manage [instruction]` — Manage context now, optionally with specific compression guidance");
    lines.push("- `/compress squash [instruction]` — Replace one agent-selected range of existing compressed blocks");
    lines.push("- `/compress auto [status|on|off|threshold N|ratio N|reset]` — Control automatic compression for this session");
    lines.push("- `/compress help` — Show this command list");
    lines.push("");
    lines.push("Session `auto off` disables all automatic compression, including both absolute and ratio triggers, until you turn it back on.");
    return lines.join("\n");
}
export async function handleHelpCommand(ctx) {
    const { client, state, logger, sessionId, messages } = ctx;
    const message = formatHelpMessage();
    const params = getCurrentParams(state, messages, logger);
    await sendIgnoredMessage(client, sessionId, message, params, logger);
    logger.info("Help command executed");
}
//# sourceMappingURL=help.js.map