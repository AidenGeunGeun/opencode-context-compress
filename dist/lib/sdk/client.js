function unwrapClientData(response) {
    if (response && typeof response === "object" && "data" in response) {
        return response.data;
    }
    return response;
}
function usesFlatRequestShape(client) {
    if (!client || typeof client !== "object") {
        return false;
    }
    const record = client;
    return "client" in record && !("_client" in record);
}
export async function getSession(client, sessionId) {
    const sessionClient = client?.session;
    if (typeof sessionClient?.get !== "function") {
        return undefined;
    }
    const response = usesFlatRequestShape(client)
        ? await sessionClient.get({ sessionID: sessionId })
        : await sessionClient.get({ path: { id: sessionId } });
    return unwrapClientData(response);
}
export async function listSessionMessages(client, sessionId, options) {
    const sessionClient = client?.session;
    if (typeof sessionClient?.messages !== "function") {
        return [];
    }
    const response = usesFlatRequestShape(client)
        ? await sessionClient.messages({
            sessionID: sessionId,
            ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        })
        : await sessionClient.messages({
            path: { id: sessionId },
            ...(options?.limit !== undefined ? { query: { limit: options.limit } } : {}),
        });
    const data = unwrapClientData(response);
    return Array.isArray(data) ? data : [];
}
export async function promptSession(client, input) {
    const sessionClient = client?.session;
    if (typeof sessionClient?.prompt !== "function") {
        throw new Error("Session prompt API is unavailable");
    }
    const model = input.model
        ? {
            providerID: input.model.providerID,
            modelID: input.model.modelID,
        }
        : undefined;
    if (usesFlatRequestShape(client)) {
        return sessionClient.prompt({
            sessionID: input.sessionId,
            parts: input.parts,
            agent: input.agent,
            model,
            variant: input.variant,
            noReply: input.noReply,
            messageID: input.messageId,
        });
    }
    return sessionClient.prompt({
        path: {
            id: input.sessionId,
        },
        body: {
            parts: input.parts,
            agent: input.agent,
            model,
            variant: input.variant,
            noReply: input.noReply,
            messageID: input.messageId,
        },
    });
}
export async function promptSessionAsync(client, input) {
    const sessionClient = client?.session;
    if (typeof sessionClient?.promptAsync !== "function") {
        return promptSession(client, input);
    }
    const model = input.model
        ? {
            providerID: input.model.providerID,
            modelID: input.model.modelID,
        }
        : undefined;
    if (usesFlatRequestShape(client)) {
        return sessionClient.promptAsync({
            sessionID: input.sessionId,
            parts: input.parts,
            agent: input.agent,
            model,
            variant: input.variant,
            noReply: input.noReply,
            messageID: input.messageId,
        });
    }
    return sessionClient.promptAsync({
        path: {
            id: input.sessionId,
        },
        body: {
            parts: input.parts,
            agent: input.agent,
            model,
            variant: input.variant,
            noReply: input.noReply,
            messageID: input.messageId,
        },
    });
}
export async function showToast(client, input) {
    const tuiClient = client?.tui;
    if (typeof tuiClient?.showToast !== "function") {
        return false;
    }
    try {
        if (usesFlatRequestShape(client)) {
            await tuiClient.showToast({
                title: input.title,
                message: input.message,
                variant: input.variant,
                duration: input.duration,
                directory: input.directory,
            });
            return true;
        }
        await tuiClient.showToast({
            body: {
                title: input.title,
                message: input.message,
                variant: input.variant,
                duration: input.duration,
            },
            ...(input.directory ? { query: { directory: input.directory } } : {}),
        });
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=client.js.map