/**
 * OpenCode >= PR #18559 passes `cancelled` on the hook output object.
 * OCO catches legacy sentinel throws and returns 204.
 * Stock OpenCode 1.15.x does neither — throwing surfaces as a desktop 500.
 */
let legacySentinelSuppression = process.env.OPENCODE_CONTEXT_COMPRESS_LEGACY_SUPPRESSION === "1";
export function configureCommandSuppression(options) {
    if (options.legacySentinel !== undefined) {
        legacySentinelSuppression = options.legacySentinel;
    }
}
export function supportsCommandCancellation(output) {
    return "cancelled" in output;
}
export function suppressDefaultCommandExecution(output, sentinel) {
    // Mutate the same array SessionPrompt.command() keeps — reassignment would not clear it.
    output.parts.splice(0, output.parts.length);
    if (supportsCommandCancellation(output) || !legacySentinelSuppression) {
        output.cancelled = true;
        return;
    }
    throw new Error(sentinel);
}
//# sourceMappingURL=suppress.js.map