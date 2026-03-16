import type { Logger } from "../logger"
import type { SessionState } from "../state"
import { formatStatsHeader, formatTokenCount, formatProgressBar } from "./utils"
import type { PluginConfig } from "../config"

const TOAST_BODY_MAX_LINES = 12
const TOAST_SUMMARY_MAX_CHARS = 600

function truncateToastBody(body: string, maxLines: number = TOAST_BODY_MAX_LINES): string {
    const lines = body.split("\n")
    if (lines.length <= maxLines) {
        return body
    }
    const kept = lines.slice(0, maxLines - 1)
    const remaining = lines.length - maxLines + 1
    return kept.join("\n") + `\n... and ${remaining} more`
}

function truncateToastSummary(summary: string, maxChars: number = TOAST_SUMMARY_MAX_CHARS): string {
    if (summary.length <= maxChars) {
        return summary
    }
    return summary.slice(0, maxChars - 3) + "..."
}

function buildMinimalMessage(state: SessionState): string {
    return formatStatsHeader(state.stats.totalCompressTokens, state.stats.compressTokenCounter)
}

function buildDetailedMessage(args: {
    state: SessionState
    toolIds: string[]
    itemCount: number
    topic: string
    summary: string
    startResult: any
    endResult: any
    totalMessages: number
    rangeTokenEstimate?: number
    showCompression: boolean
}): string {
    const {
        state,
        toolIds,
        itemCount,
        topic,
        summary,
        startResult,
        endResult,
        totalMessages,
        rangeTokenEstimate,
        showCompression,
    } = args

    let message = formatStatsHeader(state.stats.totalCompressTokens, state.stats.compressTokenCounter)
    const rangeTokenCount = rangeTokenEstimate ?? state.stats.compressTokenCounter
    const rangeTokenCountLabel = `~${formatTokenCount(rangeTokenCount)}`
    const progressBar = formatProgressBar(totalMessages, startResult.messageIndex, endResult.messageIndex, 25)

    message += `\n\n▣ Compressing (${rangeTokenCountLabel}) ${progressBar}`
    message += `\n→ Topic: ${topic}`
    message += `\n→ Items: ${itemCount} ${itemCount === 1 ? "entry" : "entries"}`
    message +=
        toolIds.length > 0
            ? ` and ${toolIds.length} tools condensed`
            : " condensed"

    if (showCompression) {
        message += `\n→ Compression: ${summary}`
    }

    return message
}

export async function sendCompressNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    toolIds: string[],
    itemCount: number,
    topic: string,
    summary: string,
    startResult: any,
    endResult: any,
    totalMessages: number,
    params: any,
    rangeTokenEstimate?: number,
): Promise<boolean> {
    if (config.notification === "off") {
        return false
    }

    const message =
        config.notification === "minimal"
            ? buildMinimalMessage(state)
            : buildDetailedMessage({
                  state,
                  toolIds,
                  itemCount,
                  topic,
                  summary,
                  startResult,
                  endResult,
                  totalMessages,
                  rangeTokenEstimate,
                  showCompression: config.tools.compress.showCompression,
              })

    if (config.notificationType === "toast") {
        let toastMessage = message
        if (config.tools.compress.showCompression) {
            const truncatedSummary = truncateToastSummary(summary)
            if (truncatedSummary !== summary) {
                toastMessage = toastMessage.replace(
                    `\n→ Compression: ${summary}`,
                    `\n→ Compression: ${truncatedSummary}`,
                )
            }
        }
        toastMessage =
            config.notification === "minimal" ? toastMessage : truncateToastBody(toastMessage)

        await client.tui.showToast({
            body: {
                title: "Compress Notification",
                message: toastMessage,
                variant: "info",
                duration: 5000,
            },
        })
        return true
    }

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger,
): Promise<void> {
    const agent = params.agent || undefined
    const variant = params.variant || undefined
    const model =
        params.providerId && params.modelId
            ? {
                  providerID: params.providerId,
                  modelID: params.modelId,
              }
            : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionID,
            },
            body: {
                noReply: true,
                agent: agent,
                model: model,
                variant: variant,
                parts: [
                    {
                        type: "text",
                        text: text,
                        ignored: true,
                    },
                ],
            },
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}
