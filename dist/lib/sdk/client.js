import { adaptProjectedMessages } from "../messages/v2-adapter.js";
export function pluginClient(session) {
    return { kind: "promise-plugin", selections: new Map(), session };
}
export function setSessionSelection(client, sessionID, selection) {
    client.selections.set(sessionID, selection);
}
export async function listSessionMessages(client, sessionId) {
    const values = await client.session.context({ sessionID: sessionId });
    if (values.every((value) => typeof value === "object" &&
        value !== null &&
        "info" in value &&
        "parts" in value))
        return values;
    return adaptProjectedMessages(sessionId, values, client.selections.get(sessionId));
}
export async function promptSession(client, input) {
    const text = input.parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n\n");
    if (!text)
        throw new Error("Session prompt requires text");
    if (input.noReply) {
        return client.session.synthetic({
            sessionID: input.sessionId,
            text,
            description: text,
            metadata: { "opencode.context-compress.ignored": true },
            resume: false,
        });
    }
    return client.session.prompt({
        sessionID: input.sessionId,
        text,
        id: input.messageId,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        delivery: "steer",
        resume: true,
    });
}
export async function showToast(..._args) {
    return false;
}
//# sourceMappingURL=client.js.map