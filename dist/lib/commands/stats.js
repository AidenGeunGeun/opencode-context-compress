/**
 * Compress stats command handler.
 * Shows compression statistics for the current session and all-time totals.
 */
import { sendIgnoredMessage } from "../ui/notification";
import { formatTokenCount } from "../ui/utils";
import { loadAllSessionStats } from "../state/persistence";
import { getCurrentParams } from "../token-utils";
function formatStatsMessage(sessionTokens, sessionTools, sessionMessages, allTime) {
    const lines = [];
    lines.push("╭───────────────────────────────────────────────────────────╮");
    lines.push("│                 Compress Statistics                       │");
    lines.push("╰───────────────────────────────────────────────────────────╯");
    lines.push("");
    lines.push("Session:");
    lines.push("─".repeat(60));
    lines.push(`  Tokens saved:    ~${formatTokenCount(sessionTokens)}`);
    lines.push(`  Tools compressed: ${sessionTools}`);
    lines.push(`  Messages compressed: ${sessionMessages}`);
    lines.push("");
    lines.push("All-time:");
    lines.push("─".repeat(60));
    lines.push(`  Tokens saved:    ~${formatTokenCount(allTime.totalTokens)}`);
    lines.push(`  Tools compressed: ${allTime.totalTools}`);
    lines.push(`  Messages compressed: ${allTime.totalMessages}`);
    lines.push(`  Sessions:         ${allTime.sessionCount}`);
    return lines.join("\n");
}
export async function handleStatsCommand(ctx) {
    const { client, state, logger, sessionId, messages } = ctx;
    // Session stats from in-memory state
    const sessionTokens = state.stats.totalCompressTokens;
    const sessionTools = state.compressed.toolIds.size;
    const sessionMessages = state.compressed.messageIds.size;
    // All-time stats from storage files
    const allTime = await loadAllSessionStats(logger);
    const message = formatStatsMessage(sessionTokens, sessionTools, sessionMessages, allTime);
    const params = getCurrentParams(state, messages, logger);
    await sendIgnoredMessage(client, sessionId, message, params, logger);
    logger.info("Stats command executed", {
        sessionTokens,
        sessionTools,
        sessionMessages,
        allTimeTokens: allTime.totalTokens,
        allTimeTools: allTime.totalTools,
        allTimeMessages: allTime.totalMessages,
    });
}
//# sourceMappingURL=stats.js.map