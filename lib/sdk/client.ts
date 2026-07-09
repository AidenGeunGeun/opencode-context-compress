export type ToastVariant = "info" | "success" | "warning" | "error"

export interface ToastInput {
    title?: string
    message: string
    variant: ToastVariant
    duration?: number
    directory?: string
}

export interface SessionPromptInput {
    sessionId: string
    parts: Array<Record<string, unknown>>
    agent?: string
    model?: {
        providerID: string
        modelID: string
    }
    variant?: string
    noReply?: boolean
    messageId?: string
}

function unwrapClientData<T>(response: T | { data?: T }): T {
    if (response && typeof response === "object" && "data" in response) {
        return (response as { data?: T }).data as T
    }
    return response as T
}

function usesFlatRequestShape(client: unknown): boolean {
    if (!client || typeof client !== "object") {
        return false
    }

    const record = client as { _client?: unknown; client?: unknown }
    return "client" in record && !("_client" in record)
}

export async function getSession(client: unknown, sessionId: string): Promise<Record<string, unknown> | undefined> {
    const sessionClient = (client as { session?: { get?: (input: unknown) => Promise<unknown> } })?.session
    if (typeof sessionClient?.get !== "function") {
        return undefined
    }

    const response = usesFlatRequestShape(client)
        ? await sessionClient.get({ sessionID: sessionId })
        : await sessionClient.get({ path: { id: sessionId } })

    return unwrapClientData(response) as Record<string, unknown> | undefined
}

export async function listSessionMessages(
    client: unknown,
    sessionId: string,
    options?: { limit?: number },
): Promise<unknown[]> {
    const sessionClient = (client as { session?: { messages?: (input: unknown) => Promise<unknown> } })?.session
    if (typeof sessionClient?.messages !== "function") {
        return []
    }

    const response = usesFlatRequestShape(client)
        ? await sessionClient.messages({
              sessionID: sessionId,
              ...(options?.limit !== undefined ? { limit: options.limit } : {}),
          })
        : await sessionClient.messages({
              path: { id: sessionId },
              ...(options?.limit !== undefined ? { query: { limit: options.limit } } : {}),
          })

    const data = unwrapClientData(response)
    return Array.isArray(data) ? data : []
}

export async function promptSession(client: unknown, input: SessionPromptInput): Promise<unknown> {
    const sessionClient = (client as { session?: { prompt?: (input: unknown) => Promise<unknown> } })?.session
    if (typeof sessionClient?.prompt !== "function") {
        throw new Error("Session prompt API is unavailable")
    }

    const model = input.model
        ? {
              providerID: input.model.providerID,
              modelID: input.model.modelID,
          }
        : undefined

    if (usesFlatRequestShape(client)) {
        return sessionClient.prompt({
            sessionID: input.sessionId,
            parts: input.parts,
            agent: input.agent,
            model,
            variant: input.variant,
            noReply: input.noReply,
            messageID: input.messageId,
        })
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
    })
}

export async function promptSessionAsync(client: unknown, input: SessionPromptInput): Promise<unknown> {
    const sessionClient = (client as {
        session?: {
            promptAsync?: (input: unknown) => Promise<unknown>
            prompt?: (input: unknown) => Promise<unknown>
        }
    })?.session
    if (typeof sessionClient?.promptAsync !== "function") {
        return promptSession(client, input)
    }

    const model = input.model
        ? {
              providerID: input.model.providerID,
              modelID: input.model.modelID,
          }
        : undefined

    if (usesFlatRequestShape(client)) {
        return sessionClient.promptAsync({
            sessionID: input.sessionId,
            parts: input.parts,
            agent: input.agent,
            model,
            variant: input.variant,
            noReply: input.noReply,
            messageID: input.messageId,
        })
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
    })
}

export async function showToast(client: unknown, input: ToastInput): Promise<boolean> {
    const tuiClient = (client as { tui?: { showToast?: (input: unknown) => Promise<unknown> } })?.tui
    if (typeof tuiClient?.showToast !== "function") {
        return false
    }

    try {
        if (usesFlatRequestShape(client)) {
            await tuiClient.showToast({
                title: input.title,
                message: input.message,
                variant: input.variant,
                duration: input.duration,
                directory: input.directory,
            })
            return true
        }

        await tuiClient.showToast({
            body: {
                title: input.title,
                message: input.message,
                variant: input.variant,
                duration: input.duration,
            },
            ...(input.directory ? { query: { directory: input.directory } } : {}),
        })
        return true
    } catch {
        return false
    }
}
