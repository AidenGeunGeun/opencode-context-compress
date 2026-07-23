import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
import type { SessionStateManager } from "../state/state.js";
import type { PluginConfig } from "../config.js";
import type { GoalOverflowRecovery } from "../goal.js";
export interface ManageCommandContext {
    client: any;
    stateManager: SessionStateManager;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
    arguments?: string;
}
export interface ManagementTurnStartContext {
    client: any;
    stateManager: SessionStateManager;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
    systemPrompt: string;
    retainedText?: string;
    source?: "automatic" | "squash";
    triggeredByMessageId?: string;
    contextTokens?: number;
    thresholdTokens?: number;
    protectedTurns?: number;
    asyncPrompt?: boolean;
    goalOverflowRecovery?: GoalOverflowRecovery;
}
export type StagedManagementTurn = () => Promise<boolean>;
export declare function extractManageCommandResidual(args: string | undefined): string | undefined;
export declare function generateManagePromptMessageId(): string;
export declare function sendManageFailureFeedback(client: any, logger: Logger, sessionId: string, message: string, params: any): Promise<void>;
export declare function handleManageCommand(ctx: ManageCommandContext): Promise<void>;
/** Persists the turn marker; the caller must hold this session's mutation lock. */
export declare function stageManagementTurnWithinLock(ctx: ManagementTurnStartContext): Promise<StagedManagementTurn | undefined>;
export declare function startManagementTurn(ctx: ManagementTurnStartContext): Promise<boolean>;
//# sourceMappingURL=manage.d.ts.map