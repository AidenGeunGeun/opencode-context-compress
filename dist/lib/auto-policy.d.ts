import type { PluginConfig } from "./config.js";
import type { SessionState, WithParts } from "./state/index.js";
export declare const POST_COMPRESSION_COOLDOWN_RESPONSES = 3;
export interface EffectiveAutoCompressionPolicy {
    globallyEnabled: boolean;
    enabled: boolean;
    enabledSource: "config" | "session override";
    tokenThreshold: number;
    tokenThresholdSource: "config" | "session override";
    contextWindowRatio: number;
    contextWindowRatioSource: "config" | "session override";
}
export declare function resolveEffectiveAutoCompressionPolicy(config: PluginConfig["autoCompression"], state: SessionState): EffectiveAutoCompressionPolicy;
export declare function messageContainsCompressCall(message: WithParts | undefined): boolean;
export declare function getPostCompressionCooldownRemaining(state: SessionState, messages: WithParts[]): number;
export declare function isMessageWithinPostCompressionCooldown(state: SessionState, messages: WithParts[], messageId: string): boolean;
//# sourceMappingURL=auto-policy.d.ts.map