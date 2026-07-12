import type { PluginConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
import { SessionStateManager } from "../state/state.js";
export interface AutoCommandContext {
    client: any;
    stateManager: SessionStateManager;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
    arguments: string[];
}
export declare function handleAutoCommand(ctx: AutoCommandContext): Promise<void>;
//# sourceMappingURL=auto.d.ts.map