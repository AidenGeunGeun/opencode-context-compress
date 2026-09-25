import type { CompressToolContext, ToolDefinition } from "./types.js";
export interface SquashInput {
    from: string;
    to: string;
    summary: string;
    topic: string;
}
export declare function createSquashTool(ctx: CompressToolContext): ToolDefinition<SquashInput>;
//# sourceMappingURL=squash.d.ts.map