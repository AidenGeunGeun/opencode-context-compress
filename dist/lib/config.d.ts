export interface ConfigContext {
    directory: string;
}
interface CompressTool {
    permission: "ask" | "allow" | "deny";
}
interface Tools {
    compress: CompressTool;
}
interface Commands {
    enabled: boolean;
}
interface AutoCompression {
    enabled: boolean;
    contextWindowRatio: number;
    tokenThreshold: number;
}
export interface PluginConfig {
    enabled: boolean;
    debug: boolean;
    /** Daily activity log, kept for 30 days. Follows `debug` when left unset. */
    dailyLog?: boolean;
    commands: Commands;
    autoCompression: AutoCompression;
    tools: Tools;
}
export declare function refreshConfig(config: PluginConfig, ctx: ConfigContext): void;
export declare function getConfig(ctx: ConfigContext): PluginConfig;
export {};
//# sourceMappingURL=config.d.ts.map