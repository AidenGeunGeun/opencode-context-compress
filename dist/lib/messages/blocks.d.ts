import type { CompressSummary, WithParts } from "../state/index.js";
export interface OrderedCompressBlock {
    label: string;
    summary: CompressSummary;
    anchorIndex: number;
}
export declare function orderCompressBlocks(rawMessages: WithParts[], summaries: CompressSummary[]): OrderedCompressBlock[];
export declare function formatCompressBlockContent(block: Pick<OrderedCompressBlock, "label" | "summary">): string;
//# sourceMappingURL=blocks.d.ts.map