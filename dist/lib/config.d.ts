import type { PluginInput } from "@opencode-ai/plugin";
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
export interface ReportNudge {
    enabled: boolean;
    tokenInterval: number;
}
/**
 * Off unless a profile opts in: only sessions that actually maintain a handoff report file
 * have anything to update.
 */
export declare const DEFAULT_REPORT_NUDGE: ReportNudge;
export declare function resolveProtectedTurnsSetting(layer: Record<string, any>, fallback?: number, hasExplicitTopLevel?: boolean): number;
export interface PluginConfig {
    enabled: boolean;
    debug: boolean;
    /** Daily activity log. Follows `debug` when left unset. */
    dailyLog?: boolean;
    notification: "off" | "minimal" | "detailed";
    notificationType: "chat" | "toast";
    protectedTurns: number;
    commands: Commands;
    autoCompression: AutoCompression;
    reportNudge: ReportNudge;
    tools: Tools;
}
export declare const VALID_CONFIG_KEYS: Set<string>;
export declare function getInvalidConfigKeys(userConfig: Record<string, any>): string[];
export declare function mergeReportNudge(base: PluginConfig["reportNudge"], override?: Partial<PluginConfig["reportNudge"]>): PluginConfig["reportNudge"];
export declare function getConfig(ctx: PluginInput): PluginConfig;
//# sourceMappingURL=config.d.ts.map