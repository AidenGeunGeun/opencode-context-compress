import type { WithParts } from "./state";
import { SessionStateManager } from "./state";
import type { Logger } from "./logger";
import type { PluginConfig } from "./config";
export declare function getLastUserSessionId(messages: WithParts[]): string | undefined;
export declare function createChatMessageTransformHandler(client: any, stateManager: SessionStateManager, logger: Logger, config: PluginConfig, workingDirectory?: string): (_input: {}, output: {
    messages: WithParts[];
}) => Promise<void>;
export declare function createCommandExecuteHandler(client: any, stateManager: SessionStateManager, logger: Logger, config: PluginConfig): (input: {
    command: string;
    sessionID: string;
    arguments: string;
}, _output: {
    parts: any[];
}) => Promise<void>;
//# sourceMappingURL=hooks.d.ts.map