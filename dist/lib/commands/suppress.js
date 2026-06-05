export function supportsCommandCancellation(output) {
    return "cancelled" in output;
}
export function suppressDefaultCommandExecution(output, sentinel) {
    if (supportsCommandCancellation(output)) {
        output.cancelled = true;
        output.parts = [];
        return;
    }
    throw new Error(sentinel);
}
//# sourceMappingURL=suppress.js.map