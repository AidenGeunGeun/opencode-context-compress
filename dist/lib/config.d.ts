export interface ConfigContext {
    directory: string;
}
export interface CompressTool {
    permission: "ask" | "allow" | "deny";
    showCompression: boolean;
}
export interface Tools {
    compress: CompressTool;
}
export interface Commands {
    enabled: boolean;
}
export interface AutoCompression {
    enabled: boolean;
    contextWindowRatio: number;
    tokenThreshold: number;
}
export declare const DEFAULT_AUTO_COMPRESSION: AutoCompression;
export declare function resolveProtectedTurnsSetting(layer: Record<string, unknown>, fallback?: number, hasExplicitTopLevel?: boolean): number;
export interface PluginConfig {
    enabled: boolean;
    debug: boolean;
    /** Daily activity log. Follows `debug` when left unset. */
    dailyLog?: boolean;
    notification: "off" | "minimal" | "detailed";
    protectedTurns: number;
    commands: Commands;
    autoCompression: AutoCompression;
    tools: Tools;
}
export declare const VALID_CONFIG_KEYS: Set<string>;
export declare function getInvalidConfigKeys(userConfig: Record<string, unknown>): string[];
export declare function getConfig(ctx: ConfigContext): PluginConfig;
//# sourceMappingURL=config.d.ts.map