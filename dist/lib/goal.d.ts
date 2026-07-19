import { type SessionGoalOwner } from "./sdk/client.js";
export interface GoalOverflowRecovery extends SessionGoalOwner {
    overflowMessageId: string;
}
export declare function isGoalContinuationMessage(message: {
    info: {
        role: string;
    };
    parts: unknown[];
}): boolean;
export declare function isContextOverflowError(error: unknown): boolean;
export declare function renderGoalOverflowRecoveryPrompt(): string;
export declare function recoverGoalAfterCompression(client: unknown, sessionId: string, recovery: GoalOverflowRecovery): Promise<"resumed" | "changed" | "unavailable">;
//# sourceMappingURL=goal.d.ts.map