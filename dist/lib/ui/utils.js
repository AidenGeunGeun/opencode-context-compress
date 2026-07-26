export function formatStatsHeader(totalTokensSaved, compressTokenCounter) {
    const totalTokensSavedStr = `~${formatTokenCount(totalTokensSaved + compressTokenCounter)}`;
    return [`▣ Context Compress | ${totalTokensSavedStr} saved total`].join("\n");
}
export function formatTokenCount(tokens) {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + " tokens";
    }
    return tokens.toString() + " tokens";
}
export function formatProgressBar(total, start, end, width = 20) {
    if (total <= 0)
        return `│${" ".repeat(width)}│`;
    const startIdx = Math.floor((start / total) * width);
    const endIdx = Math.min(width - 1, Math.floor((end / total) * width));
    let bar = "";
    for (let i = 0; i < width; i++) {
        if (i >= startIdx && i <= endIdx) {
            bar += "░";
        }
        else {
            bar += "█";
        }
    }
    return `│${bar}│`;
}
//# sourceMappingURL=utils.js.map