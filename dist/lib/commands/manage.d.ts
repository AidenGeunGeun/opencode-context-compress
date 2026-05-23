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
export declare function extractManageCommandResidual(args: string | undefined): string | undefined;
export declare function handleManageCommand(ctx: ManageCommandContext): Promise<void>;
//# sourceMappingURL=manage.d.ts.map