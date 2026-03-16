/**
 * Compress help command handler.
 * Shows available compression commands and their descriptions.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"

export interface HelpCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

function formatHelpMessage(): string {
    const lines: string[] = []

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                   Compress Commands                       │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("  /compress context   Show token usage breakdown for current session")
    lines.push("  /compress stats     Show context compression statistics")
    lines.push("  /compress manage    Instruct the agent to manage context now")
    lines.push("  /compress help      Show this command list")
    lines.push("")

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const message = formatHelpMessage()

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Help command executed")
}
