export type CommandExecuteOutput = {
    parts: unknown[]
    cancelled?: boolean
}

export function supportsCommandCancellation(output: CommandExecuteOutput): boolean {
    return "cancelled" in output
}

export function suppressDefaultCommandExecution(output: CommandExecuteOutput): void {
    // Mutate the same array SessionPrompt.command() keeps — reassignment would not clear it.
    output.parts.splice(0, output.parts.length)
    output.cancelled = true
}
