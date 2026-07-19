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
export interface SessionGoalInfo {
    id: string;
    sessionID: string;
    objective: string;
    status: "active" | "paused" | "blocked" | "complete";
    time: {
        created: number;
        updated: number;
    };
}
export interface SessionGoalOwner {
    goalID: string;
    timeUpdated: number;
}
export declare function getSessionGoal(client: unknown, sessionId: string): Promise<SessionGoalInfo | null | undefined>;
export declare function resumeSessionGoal(client: unknown, sessionId: string, owner: SessionGoalOwner): Promise<SessionGoalInfo | undefined>;
export declare function getSession(client: unknown, sessionId: string): Promise<Record<string, unknown> | undefined>;
export declare function listSessionMessages(client: unknown, sessionId: string, options?: {
    limit?: number;
}): Promise<unknown[]>;
export declare function promptSession(client: unknown, input: SessionPromptInput): Promise<unknown>;
export declare function promptSessionAsync(client: unknown, input: SessionPromptInput): Promise<unknown>;
export declare function showToast(client: unknown, input: ToastInput): Promise<boolean>;
//# sourceMappingURL=client.d.ts.map