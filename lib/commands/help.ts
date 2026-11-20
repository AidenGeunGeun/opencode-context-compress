import type { Logger } from "../logger.js"
import type { PluginClient } from "../sdk/client.js"
import { sendIgnoredMessage } from "../ui/notification.js"

export interface HelpCommandContext {
    client: PluginClient
    logger: Logger
    sessionId: string
}

function formatHelpMessage(): string {
    const lines: string[] = []

    lines.push("**Compress commands**")
    lines.push("")
    lines.push("- `/compress context` — Show token usage breakdown for current session")
    lines.push(
        "- `/compress manage [instruction]` — Ask the agent to fold the context now, optionally with your guidance for the summary",
    )
    lines.push(
        "- `/compress off`, `/compress on`, `/compress status` — Stop, resume, or show automatic fold requests for this session",
    )
    lines.push(
        "- `/compress threshold [N|reset]` — Show or set this session's fold threshold in tokens; `reset` returns to the config value",
    )
    lines.push("- `/compress help` — Show this command list")

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, logger, sessionId } = ctx

    const message = formatHelpMessage()

    await sendIgnoredMessage(client, sessionId, message, logger)
}
