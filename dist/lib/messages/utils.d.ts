import type { SessionState, WithParts } from "../state";
export declare const COMPRESS_SUMMARY_PREFIX = "[Compressed conversation block]\n\n";
export declare const createSyntheticUserMessage: (baseMessage: WithParts, content: string, variant?: string) => WithParts;
export declare const createSyntheticTextPart: (baseMessage: WithParts, content: string) => {
    id: string;
    sessionID: string;
    messageID: string;
    type: "text";
    text: string;
};
export declare const createSyntheticToolPart: (baseMessage: WithParts, content: string, modelID: string) => {
    id: string;
    sessionID: string;
    messageID: string;
    type: "tool";
    callID: string;
    tool: string;
    state: {
        status: "completed";
        input: {};
        output: string;
        title: string;
        metadata: {
            google: {
                thoughtSignature: string;
            };
        } | {
            google?: undefined;
        };
        time: {
            start: number;
            end: number;
        };
    };
};
/**
 * Extracts a human-readable key from tool metadata for display purposes.
 */
export declare const extractParameterKey: (tool: string, parameters: any) => string;
export declare function buildToolIdList(state: SessionState, messages: WithParts[]): string[];
export declare const isIgnoredUserMessage: (message: WithParts) => boolean;
export declare const findMessageIndex: (messages: WithParts[], messageId: string) => number;
//# sourceMappingURL=utils.d.ts.map