import type { SessionState, WithParts } from "./types.js";
import type { Logger } from "../logger.js";
export interface SessionStateSyncResult {
    source: "memory" | "disk-load" | "disk-reload" | "disk-cleared";
    lastUpdated: string | null;
}
export declare function commitDurableSessionState(state: SessionState, candidate: SessionState): void;
export declare class SessionStateManager {
    private sessions;
    private mutationTails;
    get(sessionId: string): SessionState;
    has(sessionId: string): boolean;
    delete(sessionId: string): void;
    size(): number;
    runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
}
export declare const checkSession: (client: any, state: SessionState, logger: Logger, messages: WithParts[]) => Promise<SessionStateSyncResult>;
export declare function createSessionState(): SessionState;
export declare function ensureSessionInitialized(client: any, state: SessionState, sessionId: string, logger: Logger, messages: WithParts[]): Promise<SessionStateSyncResult>;
//# sourceMappingURL=state.d.ts.map