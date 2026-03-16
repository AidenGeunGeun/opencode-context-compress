import { ToolParameterEntry } from "../state"
import { extractParameterKey } from "../messages/utils"

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

export function truncate(str: string, maxLen: number = 60): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 3) + "..."
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

export function shortenPath(input: string, workingDirectory?: string): string {
    const inPathMatch = input.match(/^(.+) in (.+)$/)
    if (inPathMatch) {
        const prefix = inPathMatch[1]
        const pathPart = inPathMatch[2]
        const shortenedPath = shortenSinglePath(pathPart, workingDirectory)
        return `${prefix} in ${shortenedPath}`
    }

    return shortenSinglePath(input, workingDirectory)
}

function shortenSinglePath(path: string, workingDirectory?: string): string {
    if (workingDirectory) {
        if (path.startsWith(workingDirectory + "/")) {
            return path.slice(workingDirectory.length + 1)
        }
        if (path === workingDirectory) {
            return "."
        }
    }

    return path
}

export function formatCompressedItemsList(
    compressedToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string[] {
    const lines: string[] = []

    for (const id of compressedToolIds) {
        const metadata = toolMetadata.get(id)

        if (metadata) {
            const paramKey = extractParameterKey(metadata.tool, metadata.parameters)
            if (paramKey) {
                // Use 60 char limit to match notification style
                const displayKey = truncate(shortenPath(paramKey, workingDirectory), 60)
                lines.push(`→ ${metadata.tool}: ${displayKey}`)
            } else {
                lines.push(`→ ${metadata.tool}`)
            }
        }
    }

    const knownCount = compressedToolIds.filter((id) => toolMetadata.has(id)).length
    const unknownCount = compressedToolIds.length - knownCount

    if (unknownCount > 0) {
        lines.push(`→ (${unknownCount} tool${unknownCount > 1 ? "s" : ""} with unknown metadata)`)
    }

    return lines
}

export function formatCompressionResultForTool(
    compressedIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string {
    const lines: string[] = []
    lines.push(`Context compression complete. Compressed ${compressedIds.length} tool outputs.`)
    lines.push("")

    if (compressedIds.length > 0) {
        lines.push(`Semantically compressed (${compressedIds.length}):`)
        lines.push(...formatCompressedItemsList(compressedIds, toolMetadata, workingDirectory))
    }

    return lines.join("\n").trim()
}
