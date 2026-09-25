import { formatStatsHeader, formatTokenCount, formatProgressBar } from "./utils.js";
import { promptSession, showToast } from "../sdk/client.js";
export async function sendSquashNotification(client, logger, config, sessionId, outcome) {
    if (config.notification === "off")
        return;
    const delta = outcome.oldVisibleTokens - outcome.newVisibleTokens;
    const change = delta > 0 ? "reduced" : delta < 0 ? "increased" : "unchanged";
    const message = [
        "▣ Context Squash | Complete",
        `→ Replaced: [${outcome.oldFrom}]-[${outcome.oldTo}] → [${outcome.newLabel}] (${outcome.selectedBlocks} blocks → 1)`,
        `→ Total blocks: ${outcome.blocksBefore} → ${outcome.blocksAfter} (${outcome.blocksBefore} - ${outcome.selectedBlocks} + 1)`,
        `→ Selected-block context (estimated): ${formatTokenCount(outcome.oldVisibleTokens)} → ${formatTokenCount(outcome.newVisibleTokens)}; ${change} by ${formatTokenCount(Math.abs(delta))}`,
        ...(config.notification === "detailed" ? [`→ Topic: ${outcome.topic}`] : []),
    ].join("\n");
    if (config.notificationType === "toast") {
        const shown = await showToast(client, {
            title: "Squash Notification",
            message,
            variant: "info",
            duration: 5000,
        });
        if (shown)
            return;
    }
    await sendIgnoredMessage(client, sessionId, message, {}, logger);
}
const TOAST_BODY_MAX_LINES = 12;
const TOAST_SUMMARY_MAX_CHARS = 600;
function truncateToastBody(body, maxLines = TOAST_BODY_MAX_LINES) {
    const lines = body.split("\n");
    if (lines.length <= maxLines) {
        return body;
    }
    const kept = lines.slice(0, maxLines - 1);
    const remaining = lines.length - maxLines + 1;
    return kept.join("\n") + `\n... and ${remaining} more`;
}
function truncateToastSummary(summary, maxChars = TOAST_SUMMARY_MAX_CHARS) {
    if (summary.length <= maxChars) {
        return summary;
    }
    return summary.slice(0, maxChars - 3) + "...";
}
function buildMinimalMessage(state) {
    return formatStatsHeader(state.stats.totalCompressTokens, state.stats.compressTokenCounter);
}
function buildDetailedMessage(args) {
    const { state, toolIds, itemCount, topic, summary, startResult, endResult, totalMessages, rangeTokenEstimate, showCompression, } = args;
    let message = formatStatsHeader(state.stats.totalCompressTokens, state.stats.compressTokenCounter);
    const rangeTokenCount = rangeTokenEstimate ?? state.stats.compressTokenCounter;
    const rangeTokenCountLabel = `~${formatTokenCount(rangeTokenCount)}`;
    const progressBar = formatProgressBar(totalMessages, startResult.messageIndex, endResult.messageIndex, 25);
    message += `\n\n▣ Compressing (${rangeTokenCountLabel}) ${progressBar}`;
    message += `\n→ Topic: ${topic}`;
    message += `\n→ Items: ${itemCount} ${itemCount === 1 ? "entry" : "entries"}`;
    message +=
        toolIds.length > 0
            ? ` and ${toolIds.length} tools condensed`
            : " condensed";
    if (showCompression) {
        message += `\n→ Compression: ${summary}`;
    }
    return message;
}
export async function sendCompressNotification(client, logger, config, state, sessionId, toolIds, itemCount, topic, summary, startResult, endResult, totalMessages, params, rangeTokenEstimate) {
    if (config.notification === "off") {
        return false;
    }
    const message = config.notification === "minimal"
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
        });
    if (config.notificationType === "toast") {
        let toastMessage = message;
        if (config.tools.compress.showCompression) {
            const truncatedSummary = truncateToastSummary(summary);
            if (truncatedSummary !== summary) {
                toastMessage = toastMessage.replace(`\n→ Compression: ${summary}`, `\n→ Compression: ${truncatedSummary}`);
            }
        }
        toastMessage =
            config.notification === "minimal" ? toastMessage : truncateToastBody(toastMessage);
        const shown = await showToast(client, {
            title: "Compress Notification",
            message: toastMessage,
            variant: "info",
            duration: 5000,
        });
        if (shown) {
            return true;
        }
    }
    await sendIgnoredMessage(client, sessionId, message, params, logger);
    return true;
}
export async function sendIgnoredMessage(client, sessionID, text, params, logger) {
    const agent = params.agent || undefined;
    const variant = params.variant || undefined;
    const model = params.providerId && params.modelId
        ? {
            providerID: params.providerId,
            modelID: params.modelId,
        }
        : undefined;
    try {
        await promptSession(client, {
            sessionId: sessionID,
            noReply: true,
            agent,
            model,
            variant,
            parts: [
                {
                    type: "text",
                    text: text,
                    ignored: true,
                },
            ],
        });
    }
    catch (error) {
        logger.error("Failed to send notification", { error: error.message });
    }
}
//# sourceMappingURL=notification.js.map