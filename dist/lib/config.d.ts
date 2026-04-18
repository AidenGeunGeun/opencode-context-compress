import type { PluginInput } from "@opencode-ai/plugin";
export interface CompressTool {
    permission: "ask" | "allow" | "deny";
    showCompression: boolean;
}
export interface PermissionTool {
    permission: "ask" | "allow" | "deny";
}
export interface ToolSettings {
    protectedTools: string[];
}
export interface Tools {
    settings: ToolSettings;
    compress: CompressTool;
    compress_map: PermissionTool;
}
export interface Commands {
    enabled: boolean;
    protectedTools: string[];
}
export interface TurnProtection {
    enabled: boolean;
    turns: number;
}
export interface PluginConfig {
    enabled: boolean;
    debug: boolean;
    notification: "off" | "minimal" | "detailed";
    notificationType: "chat" | "toast";
    commands: Commands;
    turnProtection: TurnProtection;
    protectedFilePatterns: string[];
    tools: Tools;
}
export declare const VALID_CONFIG_KEYS: Set<string>;
export declare function getInvalidConfigKeys(userConfig: Record<string, any>): string[];
export declare function getConfig(ctx: PluginInput): PluginConfig;
//# sourceMappingURL=config.d.ts.map