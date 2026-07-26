import { SessionState, WithParts } from "./state/index.js";
import { Logger } from "./logger.js";
export declare function isAnthropicProvider(providerId: string | undefined): boolean;
export declare function getCurrentParams(state: SessionState, messages: WithParts[], logger: Logger): {
    providerId: string | undefined;
    modelId: string | undefined;
    agent: string | undefined;
    variant: string | undefined;
};
export declare function countTokens(text: string, providerId?: string): number;
export declare function estimateTokensBatch(texts: string[], providerId?: string): number;
//# sourceMappingURL=token-utils.d.ts.map