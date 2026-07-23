import type { Logger } from "../logger.js";
import type { PluginConfig } from "../config.js";
import type { SessionState, WithParts } from "../state/index.js";
import type { SessionStateManager } from "../state/state.js";
export interface SquashCommandContext {
    client: any;
    stateManager: SessionStateManager;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
    arguments?: string;
}
export declare function extractSquashCommandResidual(args: string | undefined): string | undefined;
export declare function handleSquashCommand(ctx: SquashCommandContext): Promise<void>;
//# sourceMappingURL=squash.d.ts.map