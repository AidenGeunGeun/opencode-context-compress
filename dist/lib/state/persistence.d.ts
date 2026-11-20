import type { SessionState, CompressSummary, ManagementTurn, WithParts } from "./types.js";
import type { Logger } from "../logger.js";
interface PersistedCompressed {
    toolIds: string[];
    messageIds: string[];
}
interface PersistedSessionState {
    sessionName?: string;
    compressed: PersistedCompressed;
    anthropicStubIds?: string[];
    compressSummaries: CompressSummary[];
    managementTurns: ManagementTurn[];
    foldOff?: boolean;
    tokenThreshold?: number;
    lastCompaction?: number;
    lastUpdated: string;
}
export type LoadSessionStateResult = {
    status: "missing";
} | {
    status: "loaded";
    state: PersistedSessionState;
} | {
    status: "error";
};
export declare function saveSessionState(sessionState: SessionState, logger: Logger, sessionName?: string): Promise<boolean>;
export declare function loadSessionState(sessionId: string, logger: Logger, messages?: WithParts[]): Promise<LoadSessionStateResult>;
export {};
//# sourceMappingURL=persistence.d.ts.map