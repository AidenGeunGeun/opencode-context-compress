/**
 * Compress help command handler.
 * Shows available compression commands and their descriptions.
 */

import type { Logger } from "../logger.js"
import type { SessionState, WithParts } from "../state/index.js"
import { sendIgnoredMessage } from "../ui/notification.js"
import { getCurrentParams } from "../token-utils.js"

export interface HelpCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

function formatHelpMessage(): string {
    const lines: string[] = []

    lines.push("**Compress commands**")
    lines.push("")
    lines.push("- `/compress context` — Show token usage breakdown for current session")
    lines.push("- `/compress stats` — Show context compression statistics")
    lines.push("- `/compress manage` — Instruct the agent to manage context now")
    lines.push("- `/compress auto [status|on|off|threshold N|ratio N|reset]` — Control automatic compression for this session")
    lines.push("- `/compress help` — Show this command list")
    lines.push("")
    lines.push("Session `auto off` disables all automatic compression, including both absolute and ratio triggers, until you turn it back on.")

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const message = formatHelpMessage()

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Help command executed")
}
