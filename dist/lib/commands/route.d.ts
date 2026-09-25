import type { PluginConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { SessionStateManager } from "../state/index.js";
export declare function handleCompressCommand(input: {
    command: string;
    sessionID: string;
    arguments: string;
}, dependencies: {
    client: any;
    stateManager: SessionStateManager;
    logger: Logger;
    config: PluginConfig;
}): Promise<boolean>;
//# sourceMappingURL=route.d.ts.map