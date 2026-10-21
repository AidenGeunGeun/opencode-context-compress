import type { Logger } from "../logger.js"
import type { SessionState } from "../state/index.js"
import { formatStatsHeader, formatTokenCount, formatProgressBar } from "./utils.js"
import type { PluginConfig } from "../config.js"
import { type PluginClient, promptSession } from "../sdk/client.js"
import type { CompressToolContext } from "../tools/types.js"

export async function sendSquashNotification(
    client: CompressToolContext["client"],
    logger: Logger,
    config: PluginConfig,
    sessionId: string,
    outcome: {
        oldFrom: string
        oldTo: string
        newLabel: string
        topic: string
        selectedBlocks: number
        blocksBefore: number
        blocksAfter: number
        oldVisibleTokens: number
        newVisibleTokens: number
    },
): Promise<void> {
    if (config.notification === "off") return
    const delta = outcome.oldVisibleTokens - outcome.newVisibleTokens
    const change = delta > 0 ? "reduced" : delta < 0 ? "increased" : "unchanged"
    const message = [
        "▣ Context Squash | Complete",
        `→ Replaced: [${outcome.oldFrom}]-[${outcome.oldTo}] → [${outcome.newLabel}] (${outcome.selectedBlocks} blocks → 1)`,
        `→ Total blocks: ${outcome.blocksBefore} → ${outcome.blocksAfter} (${outcome.blocksBefore} - ${outcome.selectedBlocks} + 1)`,
        `→ Selected-block context (estimated): ${formatTokenCount(outcome.oldVisibleTokens)} → ${formatTokenCount(outcome.newVisibleTokens)}; ${change} by ${formatTokenCount(Math.abs(delta))}`,
        ...(config.notification === "detailed" ? [`→ Topic: ${outcome.topic}`] : []),
    ].join("\n")
    await sendIgnoredMessage(client, sessionId, message, logger)
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
    startResult: { messageIndex: number }
    endResult: { messageIndex: number }
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

    let message = formatStatsHeader(
        state.stats.totalCompressTokens,
        state.stats.compressTokenCounter,
    )
    const rangeTokenCount = rangeTokenEstimate ?? state.stats.compressTokenCounter
    const rangeTokenCountLabel = `~${formatTokenCount(rangeTokenCount)}`
    const progressBar = formatProgressBar(
        totalMessages,
        startResult.messageIndex,
        endResult.messageIndex,
        25,
    )

    message += `\n\n▣ Compressing (${rangeTokenCountLabel}) ${progressBar}`
    message += `\n→ Topic: ${topic}`
    message += `\n→ Items: ${itemCount} ${itemCount === 1 ? "entry" : "entries"}`
    message += toolIds.length > 0 ? ` and ${toolIds.length} tools condensed` : " condensed"

    if (showCompression) {
        message += `\n→ Compression: ${summary}`
    }

    return message
}

export async function sendCompressNotification(
    client: PluginClient,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    toolIds: string[],
    itemCount: number,
    topic: string,
    summary: string,
    startResult: { messageIndex: number },
    endResult: { messageIndex: number },
    totalMessages: number,
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

    await sendIgnoredMessage(client, sessionId, message, logger)
    return true
}

export async function sendIgnoredMessage(
    client: PluginClient,
    sessionID: string,
    text: string,
    logger: Logger,
): Promise<void> {
    try {
        await promptSession(client, {
            sessionId: sessionID,
            noReply: true,
            parts: [
                {
                    type: "text",
                    text: text,
                    ignored: true,
                },
            ],
        })
    } catch (error) {
        logger.error("Failed to send notification", {
            error: error instanceof Error ? error.message : String(error),
        })
    }
}
