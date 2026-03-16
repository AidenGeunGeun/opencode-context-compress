import type { SessionState, WithParts } from "./types";
import type { Logger } from "../logger";
export declare const checkSession: (client: any, state: SessionState, logger: Logger, messages: WithParts[]) => Promise<void>;
export declare function createSessionState(): SessionState;
export declare function resetSessionState(state: SessionState): void;
export declare function ensureSessionInitialized(client: any, state: SessionState, sessionId: string, logger: Logger, messages: WithParts[]): Promise<void>;
//# sourceMappingURL=state.d.ts.map