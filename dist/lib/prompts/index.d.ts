/**
 * Only the Orchestrator maintains a handoff report file. Fail closed on a missing or
 * different identity so no other agent is pushed toward a file it does not keep.
 */
export declare function isReportMaintainingAgent(agent: string | undefined): boolean;
/** The Orchestrator-scoped handoff-report block, or an empty string for every other agent. */
export declare function renderReportInstruction(agent: string | undefined): string;
export declare function renderSystemPrompt(agent?: string): string;
export declare function renderAutomaticSystemPrompt(vars: Record<string, string>, agent?: string): string;
export declare function renderSquashSystemPrompt(agent?: string): string;
export declare function renderPostCompressionNotice(): string;
export declare function loadPrompt(name: string, vars?: Record<string, string>): string;
//# sourceMappingURL=index.d.ts.map