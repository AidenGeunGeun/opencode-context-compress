import type { SessionState, WithParts } from "./state/index.js";
export declare function isAnthropicProvider(providerId: string | undefined): boolean;
export declare function getCurrentProviderId(state: SessionState, messages: WithParts[]): string | undefined;
export declare function countTokens(text: string, providerId?: string): number;
export declare function estimateTokensBatch(texts: string[], providerId?: string): number;
//# sourceMappingURL=token-utils.d.ts.map