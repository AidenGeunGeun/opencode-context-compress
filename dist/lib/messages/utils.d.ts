import type { WithParts } from "../state/index.js";
export declare const COMPRESS_SUMMARY_PREFIX = "[Compressed conversation block]\n\n";
export declare const createSyntheticUserMessage: (baseMessage: WithParts, content: string, variant?: string, stableSeed?: string) => WithParts;
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
export declare const isIgnoredUserMessage: (message: WithParts) => boolean;
export declare const findMessageIndex: (messages: WithParts[], messageId: string) => number;
//# sourceMappingURL=utils.d.ts.map