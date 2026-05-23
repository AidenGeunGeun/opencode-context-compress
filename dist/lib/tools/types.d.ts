import type { SessionStateManager } from "../state/index.js";
import type { PluginConfig } from "../config.js";
import type { Logger } from "../logger.js";
export interface CompressToolContext {
    client: any;
    stateManager: SessionStateManager;
    logger: Logger;
    config: PluginConfig;
    workingDirectory: string;
}
//# sourceMappingURL=types.d.ts.map