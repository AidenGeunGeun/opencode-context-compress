import type { Logger } from "../logger.js"
import type { PluginClient } from "../sdk/client.js"
import type { SessionState, WithParts } from "../state/index.js"
import { sendIgnoredMessage } from "../ui/notification.js"
import { formatTokenCount } from "../ui/utils.js"
import { isMessageCompacted } from "../shared-utils.js"
import { isIgnoredUserMessage } from "../messages/utils.js"
import { countTokens, getCurrentProviderId } from "../token-utils.js"
import type { AssistantMessage, TextPart, ToolPart } from "../state/types.js"

export interface ContextCommandContext {
    client: PluginClient
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

interface TokenBreakdown {
    system: number
    user: number
    assistant: number
    tools: number
    toolCount: number
    compressedToolCount: number
    total: number
}

function analyzeTokens(
    state: SessionState,
    messages: WithParts[],
    providerId?: string,
): TokenBreakdown {
    const breakdown: TokenBreakdown = {
        system: 0,
        user: 0,
        assistant: 0,
        tools: 0,
        toolCount: 0,
        compressedToolCount: state.compressed.toolIds.size,
        total: 0,
    }

    let firstAssistant: AssistantMessage | undefined
    for (const msg of messages) {
        if (msg.info.role === "assistant") {
            if ((msg.info.tokens?.input ?? 0) > 0 || (msg.info.tokens?.cache?.read ?? 0) > 0) {
                firstAssistant = msg.info
                break
            }
        }
    }

    let lastAssistant: AssistantMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant") {
            if ((msg.info.tokens?.output ?? 0) > 0) {
                lastAssistant = msg.info
                break
            }
        }
    }

    const apiInput = lastAssistant?.tokens?.input || 0
    const apiOutput = lastAssistant?.tokens?.output || 0
    const apiReasoning = lastAssistant?.tokens?.reasoning || 0
    const apiCacheRead = lastAssistant?.tokens?.cache?.read || 0
    const apiCacheWrite = lastAssistant?.tokens?.cache?.write || 0
    breakdown.total = apiInput + apiOutput + apiReasoning + apiCacheRead + apiCacheWrite

    const userTextParts: string[] = []
    const toolInputParts: string[] = []
    const toolOutputParts: string[] = []
    let firstUserText = ""
    let foundFirstUser = false
    const foundToolIds = new Set<string>()

    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const isCompacted = isMessageCompacted(state, msg)
        const isIgnoredUser = msg.info.role === "user" && isIgnoredUserMessage(msg)

        for (const part of parts) {
            if (part.type === "tool") {
                const toolPart = part as ToolPart
                if (toolPart.callID && !foundToolIds.has(toolPart.callID)) {
                    breakdown.toolCount++
                    foundToolIds.add(toolPart.callID)
                }

                const isCompressed =
                    toolPart.callID && state.compressed.toolIds.has(toolPart.callID)
                if (!isCompacted && !isCompressed) {
                    if (toolPart.state?.input) {
                        const inputStr =
                            typeof toolPart.state.input === "string"
                                ? toolPart.state.input
                                : JSON.stringify(toolPart.state.input)
                        toolInputParts.push(inputStr)
                    }

                    if (toolPart.state?.status === "completed" && toolPart.state?.output) {
                        const outputStr =
                            typeof toolPart.state.output === "string"
                                ? toolPart.state.output
                                : JSON.stringify(toolPart.state.output)
                        toolOutputParts.push(outputStr)
                    }
                }
            } else if (
                part.type === "text" &&
                msg.info.role === "user" &&
                !isCompacted &&
                !isIgnoredUser
            ) {
                const textPart = part as TextPart
                const text = textPart.text || ""
                userTextParts.push(text)
                if (!foundFirstUser) {
                    firstUserText += text
                }
            }
        }

        if (msg.info.role === "user" && !isIgnoredUser && !foundFirstUser) {
            foundFirstUser = true
        }
    }

    const firstUserTokens = countTokens(firstUserText, providerId)
    breakdown.user = countTokens(userTextParts.join("\n"), providerId)
    const toolInputTokens = countTokens(toolInputParts.join("\n"), providerId)
    const toolOutputTokens = countTokens(toolOutputParts.join("\n"), providerId)

    if (firstAssistant) {
        const firstInput =
            (firstAssistant.tokens?.input || 0) + (firstAssistant.tokens?.cache?.read || 0)
        breakdown.system = Math.max(0, firstInput - firstUserTokens)
    }

    breakdown.tools = toolInputTokens + toolOutputTokens
    // Persisted reasoning belongs to assistant usage, so it absorbs the estimation residual.
    breakdown.assistant = Math.max(
        0,
        breakdown.total - breakdown.system - breakdown.user - breakdown.tools,
    )

    return breakdown
}

function createBar(value: number, maxValue: number, width: number, char: string): string {
    if (maxValue === 0) return ""
    const filled = Math.round((value / maxValue) * width)
    const bar = char.repeat(Math.max(0, filled))
    return bar
}

function formatContextMessage(breakdown: TokenBreakdown): string {
    const lines: string[] = []
    const barWidth = 30

    const toolsInContext = breakdown.toolCount - breakdown.compressedToolCount
    const toolsLabel = `Tools (${toolsInContext})`

    const categories = [
        { label: "System", value: breakdown.system, char: "█" },
        { label: "User", value: breakdown.user, char: "▓" },
        { label: "Assistant", value: breakdown.assistant, char: "▒" },
        { label: toolsLabel, value: breakdown.tools, char: "░" },
    ] as const

    const maxLabelLen = Math.max(...categories.map((c) => c.label.length))

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│               Compress Context Analysis                   │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Session Context Breakdown:")
    lines.push("─".repeat(60))
    lines.push("")

    for (const cat of categories) {
        const bar = createBar(cat.value, breakdown.total, barWidth, cat.char)
        const percentage =
            breakdown.total > 0 ? ((cat.value / breakdown.total) * 100).toFixed(1) : "0.0"
        const labelWithPct = `${cat.label.padEnd(maxLabelLen)} ${percentage.padStart(5)}% `
        const valueStr = formatTokenCount(cat.value).padStart(13)
        lines.push(`${labelWithPct}│${bar.padEnd(barWidth)}│${valueStr}`)
    }

    lines.push("")
    lines.push("─".repeat(60))
    lines.push("")

    lines.push("Summary:")

    lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)

    lines.push("")

    return lines.join("\n")
}

export async function handleContextCommand(ctx: ContextCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const breakdown = analyzeTokens(state, messages, getCurrentProviderId(state, messages))

    const message = formatContextMessage(breakdown)
    await sendIgnoredMessage(client, sessionId, message, logger)
}
