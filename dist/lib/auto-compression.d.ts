import type { PluginConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { type PluginClient } from "./sdk/client.js";
import { type SessionStateManager } from "./state/index.js";
export interface AssistantUsage {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
        read?: number;
        write?: number;
    };
}
export interface AutomaticCompressionThreshold {
    contextTokens: number;
    thresholdTokens: number;
    relativeThresholdTokens?: number;
    contextLimit?: number;
    reason: "context-window-ratio" | "absolute-token-threshold";
}
export declare function getAssistantContextTokens(tokens: AssistantUsage | undefined): number;
export declare function resolveAutomaticCompressionThreshold(contextTokens: number, config: Pick<PluginConfig["autoCompression"], "contextWindowRatio" | "tokenThreshold">, contextLimit?: number): AutomaticCompressionThreshold;
export declare function createAutomaticCompressionEventHandler(client: PluginClient, stateManager: SessionStateManager, logger: Logger, config: PluginConfig, acceptsSession?: (sessionID: string, event: unknown) => Promise<boolean>): (input: unknown) => Promise<void>;
//# sourceMappingURL=auto-compression.d.ts.map