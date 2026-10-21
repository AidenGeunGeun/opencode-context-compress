/**
 * Compress help command handler.
 * Shows available compression commands and their descriptions.
 */

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
    lines.push("- `/compress stats` — Show context compression statistics")
    lines.push(
        "- `/compress manage [instruction]` — Manage context now, optionally with specific compression guidance",
    )
    lines.push(
        "- `/compress squash [instruction]` — Replace one agent-selected range of existing compressed blocks",
    )
    lines.push(
        "- `/compress auto [status|on|off|threshold N|ratio N|reset]` — Control automatic compression for this session",
    )
    lines.push("- `/compress help` — Show this command list")
    lines.push("")
    lines.push(
        "Session `auto off` disables all automatic compression, including both absolute and ratio triggers, until you turn it back on.",
    )

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, logger, sessionId } = ctx

    const message = formatHelpMessage()

    await sendIgnoredMessage(client, sessionId, message, logger)

    logger.info("Help command executed")
}
