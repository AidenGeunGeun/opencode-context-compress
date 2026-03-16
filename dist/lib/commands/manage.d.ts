import type { Logger } from "../logger";
import type { SessionState, WithParts } from "../state";
import type { PluginConfig } from "../config";
export interface ManageCommandContext {
    client: any;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    sessionId: string;
    messages: WithParts[];
}
export declare function handleManageCommand(ctx: ManageCommandContext): Promise<void>;
//# sourceMappingURL=manage.d.ts.map