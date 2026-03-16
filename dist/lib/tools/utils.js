export function extractMessageContent(msg) {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    let content = "";
    for (const part of parts) {
        const p = part;
        switch (part.type) {
            case "text":
            case "reasoning":
                if (typeof p.text === "string") {
                    content += " " + p.text;
                }
                break;
            case "tool": {
                const state = p.state;
                if (!state)
                    break;
                // Include tool output (completed or error)
                if (state.status === "completed" && typeof state.output === "string") {
                    content += " " + state.output;
                }
                else if (state.status === "error" && typeof state.error === "string") {
                    content += " " + state.error;
                }
                // Include tool input
                if (state.input) {
                    content +=
                        " " +
                            (typeof state.input === "string"
                                ? state.input
                                : JSON.stringify(state.input));
                }
                break;
            }
            case "compaction":
                if (typeof p.summary === "string") {
                    content += " " + p.summary;
                }
                break;
            case "subtask":
                if (typeof p.summary === "string") {
                    content += " " + p.summary;
                }
                if (typeof p.result === "string") {
                    content += " " + p.result;
                }
                break;
        }
    }
    return content;
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
                if (toolState?.status === "completed" && toolState?.output) {
                    contents.push(typeof toolState.output === "string"
                        ? toolState.output
                        : JSON.stringify(toolState.output));
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