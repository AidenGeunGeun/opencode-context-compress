import { tool } from "@opencode-ai/plugin/tool";
import type { SessionState, WithParts } from "../state/index.js";
import type { CompressToolContext } from "./types.js";
interface CompressionBoundary {
    history: WithParts[];
    managementTurn?: SessionState["managementTurns"][number];
}
export declare function resolveCompressionBoundary(rawMessages: WithParts[], state: SessionState, toolMessageId: string, callId?: string): CompressionBoundary;
export declare function createCompressTool(ctx: CompressToolContext): ReturnType<typeof tool>;
export {};
//# sourceMappingURL=compress.d.ts.map