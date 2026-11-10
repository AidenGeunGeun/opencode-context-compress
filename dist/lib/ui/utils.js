export function formatTokenCount(tokens) {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K tokens`;
    }
    return `${tokens} tokens`;
}
//# sourceMappingURL=utils.js.map