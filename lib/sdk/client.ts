import type { Plugin } from "@opencode/plugin"
import { adaptProjectedMessages, type V2SessionSelection } from "../messages/v2-adapter.js"

export interface SessionPromptInput {
    sessionId: string
    parts: Array<Record<string, unknown>>
    noReply?: boolean
    messageId?: string
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    metadata?: { "opencode.context-compress.management": true }
}

export interface PluginClient {
    readonly kind: "promise-plugin"
    readonly selections: Map<string, V2SessionSelection>
    readonly session: Pick<Plugin.Context["session"], "context" | "prompt" | "synthetic">
}

export function pluginClient(session: Plugin.Context["session"]): PluginClient {
    return { kind: "promise-plugin", selections: new Map(), session }
}

export function setSessionSelection(
    client: PluginClient,
    sessionID: string,
    selection: V2SessionSelection,
): void {
    client.selections.set(sessionID, selection)
}

export async function listSessionMessages(
    client: PluginClient,
    sessionId: string,
): Promise<unknown[]> {
    const values = await client.session.context({ sessionID: sessionId })
    if (
        values.every(
            (value) =>
                typeof value === "object" &&
                value !== null &&
                "info" in value &&
                "parts" in value,
        )
    ) return values
    return adaptProjectedMessages(
        sessionId,
        values,
        client.selections.get(sessionId),
    )
}

export async function promptSession(client: PluginClient, input: SessionPromptInput): Promise<unknown> {
    const text = input.parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n\n")
    if (!text) throw new Error("Session prompt requires text")

    if (input.noReply) {
        return client.session.synthetic({
            sessionID: input.sessionId,
            text,
            description: text,
            metadata: { "opencode.context-compress.ignored": true },
            resume: false,
        })
    }

    return client.session.prompt({
        sessionID: input.sessionId,
        text,
        id: input.messageId,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        delivery: "steer",
        resume: true,
    })
}

export async function showToast(..._args: unknown[]): Promise<boolean> {
    return false
}
