import type { CompressSummary, WithParts } from "../state/index.js"
import { COMPRESS_SUMMARY_PREFIX } from "./utils.js"

export interface OrderedCompressBlock {
    label: string
    summary: CompressSummary
    anchorIndex: number
}

export function orderCompressBlocks(
    rawMessages: WithParts[],
    summaries: CompressSummary[],
): OrderedCompressBlock[] {
    const positionsByMessageId = new Map<string, number[]>()
    for (let index = 0; index < rawMessages.length; index++) {
        const messageId = rawMessages[index].info.id
        const positions = positionsByMessageId.get(messageId) ?? []
        positions.push(index)
        positionsByMessageId.set(messageId, positions)
    }

    const seenAnchors = new Set<string>()
    const ordered = summaries.map((summary) => {
        const positions = positionsByMessageId.get(summary.anchorMessageId)
        if (seenAnchors.has(summary.anchorMessageId) || positions?.length !== 1) {
            throw new Error(
                "could not reconcile an existing compressed block unambiguously with the current transcript. Nothing changed.",
            )
        }
        seenAnchors.add(summary.anchorMessageId)
        return {
            summary,
            anchorIndex: positions[0],
        }
    })

    ordered.sort((left, right) => left.anchorIndex - right.anchorIndex)
    return ordered.map((block, index) => ({
        ...block,
        label: `b${index}`,
    }))
}

export function formatCompressBlockContent(block: Pick<OrderedCompressBlock, "label" | "summary">): string {
    return `${COMPRESS_SUMMARY_PREFIX}[${block.label}]\n\n${block.summary.summary}`
}
