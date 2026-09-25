import type { SessionState, WithParts } from "../state/index.js";
import type { CompressToolContext, ToolDefinition } from "./types.js";
export interface CompressInput {
    summary: string;
    topic: string;
}
interface CompressionBoundary {
    history: WithParts[];
    managementTurn?: SessionState["managementTurns"][number];
}
export declare function resolveCompressionBoundary(rawMessages: WithParts[], state: SessionState, toolMessageId: string, callId?: string): CompressionBoundary;
export declare function createCompressTool(ctx: CompressToolContext): ToolDefinition<CompressInput>;
export {};
//# sourceMappingURL=compress.d.ts.map