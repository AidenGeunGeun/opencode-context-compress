import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
import type { PluginConfig } from "../config.js";
export interface ManageCommandContext {
    client: any;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
    arguments?: string;
}
export interface ManagementTurnStartContext {
    client: any;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
    systemPrompt: string;
    retainedText?: string;
    source?: "automatic";
    triggeredByMessageId?: string;
    contextTokens?: number;
    thresholdTokens?: number;
    protectedTurns?: number;
    asyncPrompt?: boolean;
}
export declare function extractManageCommandResidual(args: string | undefined): string | undefined;
export declare function generateManagePromptMessageId(): string;
export declare function handleManageCommand(ctx: ManageCommandContext): Promise<void>;
export declare function startManagementTurn(ctx: ManagementTurnStartContext): Promise<boolean>;
//# sourceMappingURL=manage.d.ts.map