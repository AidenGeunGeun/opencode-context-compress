import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
import type { SessionStateManager } from "../state/state.js";
import type { PluginConfig } from "../config.js";
import { type PluginClient } from "../sdk/client.js";
export interface ManageCommandContext {
    client: PluginClient;
    stateManager: SessionStateManager;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
    arguments?: string;
}
export interface ManagementTurnStartContext {
    client: PluginClient;
    stateManager: SessionStateManager;
    state: SessionState;
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
}
export type StagedManagementTurn = () => Promise<boolean>;
export declare function extractManageCommandResidual(args: string | undefined): string | undefined;
export declare function generateManagePromptMessageId(): string;
export declare function generateNativeCompactionNoticeId(sessionId: string, event: Record<string, unknown>): string | undefined;
export declare function generateAutomaticPromptMessageId(sessionId: string, trigger: WithParts["info"]): string;
export declare function handleManageCommand(ctx: ManageCommandContext): Promise<void>;
/** Persists the turn marker; the caller must hold this session's mutation lock. */
export declare function stageManagementTurnWithinLock(ctx: ManagementTurnStartContext): Promise<StagedManagementTurn | undefined>;
export declare function startManagementTurn(ctx: ManagementTurnStartContext): Promise<boolean>;
//# sourceMappingURL=manage.d.ts.map