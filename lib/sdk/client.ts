import type { Plugin } from "@opencode/plugin"
import { adaptProjectedMessages, type V2SessionSelection } from "../messages/v2-adapter.js"
import type { WithParts } from "../state/types.js"

export interface SessionPromptInput {
    sessionId: string
    parts: Array<Record<string, unknown>>
    noReply?: boolean
    messageId?: string
    metadata?: { "opencode.context-compress.management": true }
}

export interface PluginClient {
    readonly kind: "promise-plugin"
    readonly selections: Map<string, V2SessionSelection>
    readonly session: Pick<Plugin.Context["session"], "context" | "prompt" | "synthetic">
}

export function pluginClient(session: PluginClient["session"]): PluginClient {
    return { kind: "promise-plugin", selections: new Map(), session }
}

export function setSessionSelection(
    client: PluginClient,
    sessionID: string,
    selection: V2SessionSelection,
): void {
    client.selections.set(sessionID, selection)
}

function isAdaptedTranscript(values: readonly unknown[]): values is WithParts[] {
    return values.every(
        (value) =>
            typeof value === "object" && value !== null && "info" in value && "parts" in value,
    )
}

export async function listSessionMessages(
    client: PluginClient,
    sessionId: string,
): Promise<WithParts[]> {
    const values = await client.session.context({ sessionID: sessionId })
    if (isAdaptedTranscript(values)) return values
    return adaptProjectedMessages(sessionId, values, client.selections.get(sessionId))
}

export async function promptSession(
    client: PluginClient,
    input: SessionPromptInput,
): Promise<unknown> {
    const text = input.parts
        .flatMap((part) =>
            part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("\n\n")
    if (!text) throw new Error("Session prompt requires text")

    if (input.noReply) {
        return client.session.synthetic({
            sessionID: input.sessionId,
            id: input.messageId,
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
