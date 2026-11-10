export function deriveProtectedTailMessageIds(messages, protectedTurns) {
    if (protectedTurns <= 0 || messages.length === 0)
        return [];
    let protectedStart = 0;
    let stepCount = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        protectedStart = index;
        const parts = Array.isArray(messages[index].parts) ? messages[index].parts : [];
        stepCount += parts.filter((part) => part.type === "step-start").length;
        if (stepCount >= protectedTurns)
            break;
    }
    if (stepCount === 0) {
        protectedStart = Math.max(0, messages.length - protectedTurns);
    }
    return messages.slice(protectedStart).map((message) => message.info.id);
}
//# sourceMappingURL=context-map.js.map