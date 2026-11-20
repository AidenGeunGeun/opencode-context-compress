import type { Logger } from "../logger.js";
import type { PluginClient } from "../sdk/client.js";
import type { SessionState, WithParts } from "../state/index.js";
export interface ContextCommandContext {
    client: PluginClient;
    state: SessionState;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
}
export declare function handleContextCommand(ctx: ContextCommandContext): Promise<void>;
//# sourceMappingURL=context.d.ts.map