import type { Plugin } from "@opencode/plugin";
import { type V2SessionSelection } from "../messages/v2-adapter.js";
export interface SessionPromptInput {
    sessionId: string;
    parts: Array<Record<string, unknown>>;
    noReply?: boolean;
    messageId?: string;
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    variant?: string;
    metadata?: {
        "opencode.context-compress.management": true;
    };
}
export interface PluginClient {
    readonly kind: "promise-plugin";
    readonly selections: Map<string, V2SessionSelection>;
    readonly session: Pick<Plugin.Context["session"], "context" | "prompt" | "synthetic">;
}
export declare function pluginClient(session: Plugin.Context["session"]): PluginClient;
export declare function setSessionSelection(client: PluginClient, sessionID: string, selection: V2SessionSelection): void;
export declare function listSessionMessages(client: PluginClient, sessionId: string): Promise<unknown[]>;
export declare function promptSession(client: PluginClient, input: SessionPromptInput): Promise<unknown>;
export declare function showToast(..._args: unknown[]): Promise<boolean>;
//# sourceMappingURL=client.d.ts.map