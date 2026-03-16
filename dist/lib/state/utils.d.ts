import type { SessionState, WithParts } from "./types";
export declare function isSubAgentSession(client: any, sessionID: string): Promise<boolean>;
export declare function findLastCompactionTimestamp(messages: WithParts[]): number;
export declare function countTurns(state: SessionState, messages: WithParts[]): number;
export declare function resetOnCompaction(state: SessionState): void;
//# sourceMappingURL=utils.d.ts.map