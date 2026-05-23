export type ToastVariant = "info" | "success" | "warning" | "error";
export interface ToastInput {
    title?: string;
    message: string;
    variant: ToastVariant;
    duration?: number;
    directory?: string;
}
export interface SessionPromptInput {
    sessionId: string;
    parts: Array<Record<string, unknown>>;
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    variant?: string;
    noReply?: boolean;
    messageId?: string;
}
export declare function getSession(client: unknown, sessionId: string): Promise<Record<string, unknown> | undefined>;
export declare function listSessionMessages(client: unknown, sessionId: string, options?: {
    limit?: number;
}): Promise<unknown[]>;
export declare function promptSession(client: unknown, input: SessionPromptInput): Promise<unknown>;
export declare function showToast(client: unknown, input: ToastInput): Promise<boolean>;
//# sourceMappingURL=client.d.ts.map