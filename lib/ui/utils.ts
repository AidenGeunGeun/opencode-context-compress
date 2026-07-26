export function formatStatsHeader(totalTokensSaved: number, compressTokenCounter: number): string {
    const totalTokensSavedStr = `~${formatTokenCount(totalTokensSaved + compressTokenCounter)}`
    return [`▣ Context Compress | ${totalTokensSavedStr} saved total`].join("\n")
}

export function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + " tokens"
    }
    return tokens.toString() + " tokens"
}

export function formatProgressBar(
    total: number,
    start: number,
    end: number,
    width: number = 20,
): string {
    if (total <= 0) return `│${" ".repeat(width)}│`

    const startIdx = Math.floor((start / total) * width)
    const endIdx = Math.min(width - 1, Math.floor((end / total) * width))

    let bar = ""
    for (let i = 0; i < width; i++) {
        if (i >= startIdx && i <= endIdx) {
            bar += "░"
        } else {
            bar += "█"
        }
    }

    return `│${bar}│`
}
