export type CommandExecuteOutput = {
    parts: unknown[];
    cancelled?: boolean;
};
export declare function supportsCommandCancellation(output: CommandExecuteOutput): boolean;
export declare function suppressDefaultCommandExecution(output: CommandExecuteOutput): void;
//# sourceMappingURL=suppress.d.ts.map