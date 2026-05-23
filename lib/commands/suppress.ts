export type CommandExecuteOutput = {
    parts: unknown[]
    cancelled?: boolean
}

export type CommandHandledSentinel =
    | "__COMPRESS_CONTEXT_HANDLED__"
    | "__COMPRESS_STATS_HANDLED__"
    | "__COMPRESS_MANAGE_HANDLED__"
    | "__COMPRESS_HELP_HANDLED__"

export function supportsCommandCancellation(output: CommandExecuteOutput): boolean {
    return "cancelled" in output
}

export function suppressDefaultCommandExecution(
    output: CommandExecuteOutput,
    sentinel: CommandHandledSentinel,
): void {
    if (supportsCommandCancellation(output)) {
        output.cancelled = true
        output.parts = []
        return
    }

    throw new Error(sentinel)
}
