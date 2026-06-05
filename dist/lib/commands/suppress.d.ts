export type CommandExecuteOutput = {
    parts: unknown[];
    cancelled?: boolean;
};
export type CommandHandledSentinel = "__COMPRESS_CONTEXT_HANDLED__" | "__COMPRESS_STATS_HANDLED__" | "__COMPRESS_MANAGE_HANDLED__" | "__COMPRESS_HELP_HANDLED__";
export declare function configureCommandSuppression(options: {
    legacySentinel?: boolean;
}): void;
export declare function supportsCommandCancellation(output: CommandExecuteOutput): boolean;
export declare function suppressDefaultCommandExecution(output: CommandExecuteOutput, sentinel: CommandHandledSentinel): void;
//# sourceMappingURL=suppress.d.ts.map