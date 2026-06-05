export function supportsCommandCancellation(output) {
    return "cancelled" in output;
}
export function suppressDefaultCommandExecution(output) {
    // Mutate the same array SessionPrompt.command() keeps — reassignment would not clear it.
    output.parts.splice(0, output.parts.length);
    output.cancelled = true;
}
//# sourceMappingURL=suppress.js.map