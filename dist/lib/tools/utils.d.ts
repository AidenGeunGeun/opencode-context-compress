import type { SessionState, WithParts } from "../state";
export declare function extractMessageContent(msg: WithParts): string;
export declare function collectToolIdsInRange(messages: WithParts[], startIndex: number, endIndex: number): string[];
export declare function collectContentInRange(messages: WithParts[], startIndex: number, endIndex: number): string[];
export declare function registerToolOutputForStripping(state: SessionState, toolCtx: {
    callID?: string;
    callId?: string;
} | undefined): void;
export declare function stripManagementToolMessages(messages: WithParts[], state: SessionState): WithParts[];
//# sourceMappingURL=utils.d.ts.map