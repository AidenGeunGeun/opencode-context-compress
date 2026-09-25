import { applyCompressTransforms } from "./compress-transform.js";
import { isIgnoredUserMessage } from "./utils.js";
export function transformV2Messages(raw, state, logger, modelMessages) {
    const projected = new Map(raw.map((message) => [message.info.id, message]));
    const tools = new Map();
    for (const message of raw) {
        for (const part of message.parts) {
            if (part.type !== "tool")
                continue;
            if (tools.has(part.callID))
                throw new Error(`Duplicate projected tool call ID: ${part.callID}`);
            tools.set(part.callID, message.info.id);
        }
    }
    const owned = new Map();
    const passthrough = [];
    const system = raw.filter((message) => message.info.sourceType === "system");
    const usedSystem = new Set();
    for (const value of modelMessages) {
        const message = structuredClone(value);
        if (message.id === undefined &&
            message.role === "assistant" &&
            message.content.every((part) => part.type === "text" || part.type === "reasoning")) {
            passthrough.push(message);
            continue;
        }
        const owner = resolveOwner(message, projected, tools, system, usedSystem);
        if (!owner) {
            passthrough.push(message);
            continue;
        }
        const current = owned.get(owner) ?? [];
        current.push(message);
        owned.set(owner, current);
    }
    const transformed = structuredClone(raw);
    applyCompressTransforms(state, logger, transformed);
    return [
        ...transformed.flatMap((message) => {
            if (message.info.role === "user" && isIgnoredUserMessage(message))
                return [];
            if (!projected.has(message.info.id))
                return [summaryMessage(message)];
            const source = projected.get(message.info.id);
            if (!source)
                throw new Error(`Missing projected source for ${message.info.id}`);
            const messages = owned.get(message.info.id) ?? [];
            if (messages.length === 0)
                return [];
            if (message.info.role === "assistant")
                return transformToolPair(messages, message, state);
            if (message.info.role === "user" && text(message) !== text(source)) {
                return messages.map((item) => ({ ...item, content: [{ type: "text", text: text(message) }] }));
            }
            return messages;
        }),
        ...passthrough,
    ];
}
function resolveOwner(message, projected, tools, system, usedSystem) {
    if (message.id && projected.has(message.id))
        return message.id;
    const resultOwners = new Set(message.content
        .filter((part) => part.type === "tool-result" && typeof part.id === "string")
        .map((part) => tools.get(part.id))
        .filter((owner) => owner !== undefined));
    if (resultOwners.size === 1 && message.content.every((part) => part.type === "tool-result")) {
        return [...resultOwners][0];
    }
    if (message.role === "system") {
        const content = textFromModel(message);
        const match = system.find((candidate) => !usedSystem.has(candidate.info.id) && text(candidate) === content);
        if (match) {
            usedSystem.add(match.info.id);
            return match.info.id;
        }
    }
    if (message.id === undefined && (message.role === "user" || message.role === "system"))
        return undefined;
    throw new Error(`Could not map a model-facing ${message.role} message to authoritative projected history`);
}
function transformToolPair(messages, target, state) {
    const tools = new Map(target.parts.filter((part) => part.type === "tool").map((part) => [part.callID, part]));
    return messages.flatMap((message) => {
        const content = message.content.flatMap((part) => {
            if ((part.type !== "tool-call" && part.type !== "tool-result") || typeof part.id !== "string")
                return [part];
            const tool = tools.get(part.id);
            if (!tool)
                return [];
            if (part.type === "tool-call" && typeof tool.state.input !== "string") {
                return [{ ...part, input: structuredClone(tool.state.input) }];
            }
            if (part.type === "tool-result" &&
                state.compressed.toolIds.has(tool.callID) &&
                tool.state.status === "completed" &&
                tool.tool !== "question" &&
                tool.tool !== "edit" &&
                tool.tool !== "write") {
                return [{ ...part, result: { type: "text", value: String(tool.state.output ?? "") } }];
            }
            return [part];
        });
        if (content.length === 0)
            return [];
        return [{ ...message, content }];
    });
}
function summaryMessage(message) {
    return {
        id: message.info.id,
        role: "user",
        content: [{ type: "text", text: text(message) }],
    };
}
function text(message) {
    return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
function textFromModel(message) {
    return message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}
//# sourceMappingURL=v2-transform.js.map