import type { PluginConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { SessionStateManager } from "./state/index.js";
interface AssistantUsage {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
        read?: number;
        write?: number;
    };
}
interface AssistantMessageInfo {
    id: string;
    sessionID: string;
    role: "assistant";
    providerID?: string;
    modelID?: string;
    summary?: boolean;
    error?: unknown;
    time?: {
        completed?: number;
    };
    tokens?: AssistantUsage;
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
export declare function createChatParamsHandler(stateManager: SessionStateManager): (input: {
    sessionID: string;
    model: {
        id?: string;
        modelID?: string;
        providerID?: string;
        limit?: {
            context?: number;
        };
    };
}) => Promise<void>;
export declare function createAutomaticCompressionEventHandler(client: any, stateManager: SessionStateManager, logger: Logger, config: PluginConfig): (input: {
    event?: {
        type?: string;
        properties?: {
            info?: AssistantMessageInfo;
        };
    };
}) => Promise<void>;
export {};
//# sourceMappingURL=auto-compression.d.ts.map