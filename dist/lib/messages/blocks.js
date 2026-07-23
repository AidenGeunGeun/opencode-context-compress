import { COMPRESS_SUMMARY_PREFIX } from "./utils.js";
export function orderCompressBlocks(rawMessages, summaries) {
    const positionsByMessageId = new Map();
    for (let index = 0; index < rawMessages.length; index++) {
        const messageId = rawMessages[index].info.id;
        const positions = positionsByMessageId.get(messageId) ?? [];
        positions.push(index);
        positionsByMessageId.set(messageId, positions);
    }
    const seenAnchors = new Set();
    const ordered = summaries.map((summary) => {
        const positions = positionsByMessageId.get(summary.anchorMessageId);
        if (seenAnchors.has(summary.anchorMessageId) || positions?.length !== 1) {
            throw new Error("could not reconcile an existing compressed block unambiguously with the current transcript. Nothing changed.");
        }
        seenAnchors.add(summary.anchorMessageId);
        return {
            summary,
            anchorIndex: positions[0],
        };
    });
    ordered.sort((left, right) => left.anchorIndex - right.anchorIndex);
    return ordered.map((block, index) => ({
        ...block,
        label: `b${index}`,
    }));
}
export function formatCompressBlockContent(block) {
    return `${COMPRESS_SUMMARY_PREFIX}[${block.label}]\n\n${block.summary.summary}`;
}
//# sourceMappingURL=blocks.js.map