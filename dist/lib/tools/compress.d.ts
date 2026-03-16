import { tool } from "@opencode-ai/plugin";
import type { WithParts, CompressSummary } from "../state";
import type { CompressToolContext } from "./types";
import { type ResolvedContextMapRange } from "../messages/context-map";
export declare function removeSubsumedCompressSummaries(summaries: CompressSummary[], containedMessageIds: string[]): CompressSummary[];
export declare function composeSummaryWithPreservedBlocks(preservedSummaries: string[], newSummary: string): string;
export interface CompressionRangeMetrics {
    messageIds: string[];
    nonBlockMessageIds: string[];
    mapEntryCount: number;
    toolIds: string[];
    blockTokenEstimate: number;
    nonBlockTokenEstimate: number;
    estimatedCompressedTokens: number;
    incrementalCompressTokens: number;
}
export declare function calculateCompressionRangeMetrics(rawMessages: WithParts[], rawMessageIndexById: Map<string, number>, resolvedRange: ResolvedContextMapRange, providerId?: string): CompressionRangeMetrics;
export declare function createCompressTool(ctx: CompressToolContext): ReturnType<typeof tool>;
//# sourceMappingURL=compress.d.ts.map