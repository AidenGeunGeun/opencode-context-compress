import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ModelMessage } from "../lib/messages/v2-transform.ts"
import { type PluginClient, pluginClient } from "../lib/sdk/client.ts"
import type { Part, WithParts } from "../lib/state/types.ts"

type Session = PluginClient["session"]
type ContextInput = Parameters<Session["context"]>[0]
export type ContextMessage = Awaited<ReturnType<Session["context"]>>[number]
export type PromptInput = Parameters<Session["prompt"]>[0]
export type SyntheticInput = Parameters<Session["synthetic"]>[0]

/**
 * Points plugin config and storage at a fresh scratch root. Call it before importing modules that
 * resolve those paths at load (`lib/config.ts`, `lib/state/persistence.ts`).
 */
export async function isolateHostDirs(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "context-compress-test-"))
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_DATA_HOME = join(root, "data")
    delete process.env.OPENCODE_CONFIG_DIR
    return root
}

export interface SessionFake {
    context?: (input: ContextInput) => Promise<ContextMessage[] | WithParts[]>
    prompt?: (input: PromptInput) => unknown
    synthetic?: (input: SyntheticInput) => unknown
}

// listSessionMessages passes already-adapted transcripts through unchanged.
function asContextMessages(messages: ContextMessage[] | WithParts[]): ContextMessage[] {
    return messages as ContextMessage[]
}

export function fakeSession(fake: SessionFake = {}): Session {
    return {
        context: async (input) => asContextMessages((await fake.context?.(input)) ?? []),
        prompt: async (input) => {
            await fake.prompt?.(input)
            return {
                id: input.id ?? "prompt",
                sessionID: input.sessionID,
                time: { created: Date.now() },
                type: "user",
                payload: { text: input.text, metadata: input.metadata },
                delivery: input.delivery ?? "steer",
            }
        },
        synthetic: async (input) => {
            await fake.synthetic?.(input)
            return {
                id: input.id ?? "synthetic",
                sessionID: input.sessionID,
                time: { created: Date.now() },
                type: "synthetic",
                payload: {
                    text: input.text,
                    description: input.description ?? undefined,
                    metadata: input.metadata,
                },
                delivery: input.delivery ?? "queue",
            }
        },
    }
}

export function fakeClient(fake: SessionFake = {}): PluginClient {
    return pluginClient(fakeSession(fake))
}

type Registration = Awaited<ReturnType<Plugin.Context["command"]["transform"]>>
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

export interface CommandFake {
    readonly name: string
    readonly execute: (input: {
        sessionID: string
        prompt: { text: string }
        delivery: "steer" | "queue"
    }) => Promise<void>
}

export interface ToolFake {
    readonly name: string
    readonly execute: (
        input: Record<string, string>,
        context: {
            sessionID: string
            agent: string
            messageID: string
            id: string
            progress: () => Promise<void>
        },
    ) => Promise<{ content: string }>
}

export interface ModelHookInput {
    sessionID: string
    agent: string
    model: { providerID: string; id: string; variant?: string }
    system: string[]
    messages: ModelMessage[]
    tools: Record<string, unknown>
    options: Record<string, unknown>
}

export interface HostFake {
    readonly location: { readonly directory: string }
    readonly command: {
        readonly transform: (
            callback: (editor: { add: (command: CommandFake) => void }) => void,
        ) => Promise<Registration>
    }
    readonly tool: {
        readonly transform: (
            callback: (editor: { add: (tool: ToolFake) => void }) => void,
        ) => Promise<Registration>
    }
    readonly session: Session & {
        readonly get: (input: { sessionID: string }) => Promise<SessionInfo>
        readonly hook?: (
            name: "context" | "generate",
            callback: (input: ModelHookInput) => Promise<void> | void,
        ) => Promise<Registration>
    }
    readonly model: {
        readonly list: () => Promise<{
            data: Array<{ id: string; providerID: string; limit: { context: number } }>
        }>
    }
    readonly event: { readonly subscribe: () => AsyncIterable<unknown> }
}

// The plugin uses only these host members, with unbranded IDs, so the rest of Plugin.Context
// stays unimplemented.
export function hostContext(fake: Partial<HostFake>): Plugin.Context {
    return fake as unknown as Plugin.Context
}

export function sessionInfo(fields: Partial<SessionInfo> = {}): SessionInfo {
    return {
        id: "session",
        projectID: "project",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated: 0 },
        location: { directory: "/" },
        ...fields,
    }
}

export function partText(part: Part | undefined): string | undefined {
    return part && "text" in part && typeof part.text === "string" ? part.text : undefined
}
