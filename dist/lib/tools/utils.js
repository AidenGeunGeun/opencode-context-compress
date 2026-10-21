export function getCompletedToolOutputText(part, output, options) {
    if (part.tool === "image_generation") {
        const callId = typeof part.callID === "string" && part.callID.length > 0
            ? part.callID.length > 56
                ? `${part.callID.slice(0, 53)}...`
                : part.callID
            : undefined;
        return typeof part.callID === "string" && part.callID.length > 0
            ? `[generated image: ${callId}]`
            : "[generated image]";
    }
    if (options?.requireTruthy ? !output : output === undefined || output === null) {
        return undefined;
    }
    if (typeof output === "string") {
        return output;
    }
    if (options?.stringifyNonString) {
        return JSON.stringify(output);
    }
    return undefined;
}
export function collectToolIdsInRange(messages, startIndex, endIndex) {
    const toolIds = [];
    for (let i = startIndex; i <= endIndex; i++) {
        const msg = messages[i];
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                if (!toolIds.includes(part.callID)) {
                    toolIds.push(part.callID);
                }
            }
        }
    }
    return toolIds;
}
export function collectContentInRange(messages, startIndex, endIndex) {
    const contents = [];
    for (let i = startIndex; i <= endIndex; i++) {
        const msg = messages[i];
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        for (const part of parts) {
            if (part.type === "text") {
                contents.push(part.text);
            }
            else if (part.type === "tool") {
                const toolState = part.state;
                if (toolState?.input) {
                    contents.push(typeof toolState.input === "string"
                        ? toolState.input
                        : JSON.stringify(toolState.input));
                }
                if (toolState?.status === "completed") {
                    const output = getCompletedToolOutputText(part, toolState.output, {
                        requireTruthy: true,
                        stringifyNonString: true,
                    });
                    if (typeof output === "string") {
                        contents.push(output);
                    }
                }
                else if (toolState?.status === "error" && toolState?.error) {
                    contents.push(typeof toolState.error === "string"
                        ? toolState.error
                        : JSON.stringify(toolState.error));
                }
            }
        }
    }
    return contents;
}
//# sourceMappingURL=utils.js.map