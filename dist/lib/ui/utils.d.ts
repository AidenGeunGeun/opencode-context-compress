import { ToolParameterEntry } from "../state";
export declare function formatStatsHeader(totalTokensSaved: number, compressTokenCounter: number): string;
export declare function formatTokenCount(tokens: number): string;
export declare function truncate(str: string, maxLen?: number): string;
export declare function formatProgressBar(total: number, start: number, end: number, width?: number): string;
export declare function shortenPath(input: string, workingDirectory?: string): string;
export declare function formatCompressedItemsList(compressedToolIds: string[], toolMetadata: Map<string, ToolParameterEntry>, workingDirectory?: string): string[];
export declare function formatCompressionResultForTool(compressedIds: string[], toolMetadata: Map<string, ToolParameterEntry>, workingDirectory?: string): string;
//# sourceMappingURL=utils.d.ts.map