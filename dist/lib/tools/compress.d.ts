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
/**
 * Select the final stored summary for a compression range.
 *
 * If the range contains only existing compressed blocks and no new raw messages
 * (pure-block condense), the model's summary is used directly — prepending the
 * old block content verbatim would double the stored size and defeat the purpose.
 *
 * If the range mixes blocks and new messages, the old block content is preserved
 * alongside the new summary so nothing is silently dropped.
 */
export declare function selectFinalSummary(preservedSummaries: string[], newSummary: string, nonBlockMessageIds: string[]): string;
export declare function createCompressTool(ctx: CompressToolContext): ReturnType<typeof tool>;
//# sourceMappingURL=compress.d.ts.map