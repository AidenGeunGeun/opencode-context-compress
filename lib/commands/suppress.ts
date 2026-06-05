export type CommandExecuteOutput = {
    parts: unknown[]
    cancelled?: boolean
}

export type CommandHandledSentinel =
    | "__COMPRESS_CONTEXT_HANDLED__"
    | "__COMPRESS_STATS_HANDLED__"
    | "__COMPRESS_MANAGE_HANDLED__"
    | "__COMPRESS_HELP_HANDLED__"

/**
 * OpenCode >= PR #18559 passes `cancelled` on the hook output object.
 * OCO catches legacy sentinel throws and returns 204.
 * Stock OpenCode 1.15.x does neither — throwing surfaces as a desktop 500.
 */
let legacySentinelSuppression = process.env.OPENCODE_CONTEXT_COMPRESS_LEGACY_SUPPRESSION === "1"

export function configureCommandSuppression(options: { legacySentinel?: boolean }): void {
    if (options.legacySentinel !== undefined) {
        legacySentinelSuppression = options.legacySentinel
    }
}

export function supportsCommandCancellation(output: CommandExecuteOutput): boolean {
    return "cancelled" in output
}

export function suppressDefaultCommandExecution(
    output: CommandExecuteOutput,
    sentinel: CommandHandledSentinel,
): void {
    // Mutate the same array SessionPrompt.command() keeps — reassignment would not clear it.
    output.parts.splice(0, output.parts.length)

    if (supportsCommandCancellation(output) || !legacySentinelSuppression) {
        output.cancelled = true
        return
    }

    throw new Error(sentinel)
}
