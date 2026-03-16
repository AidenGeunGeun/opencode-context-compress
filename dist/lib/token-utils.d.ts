import { SessionState, WithParts } from "./state";
import { Logger } from "./logger";
export declare function isAnthropicProvider(providerId: string | undefined): boolean;
export declare function getCurrentParams(state: SessionState, messages: WithParts[], logger: Logger): {
    providerId: string | undefined;
    modelId: string | undefined;
    agent: string | undefined;
    variant: string | undefined;
};
export declare function countTokens(text: string, providerId?: string): number;
export declare function estimateTokensBatch(texts: string[], providerId?: string): number;
export declare function extractToolContent(part: any): string[];
export declare function countToolTokens(part: any, providerId?: string): number;
export declare const calculateTokensSaved: (state: SessionState, messages: WithParts[], compressedToolIds: string[], providerId?: string) => number;
//# sourceMappingURL=token-utils.d.ts.map