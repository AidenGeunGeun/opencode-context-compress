import type { WithParts } from "./state/index.js";
import { SessionStateManager } from "./state/index.js";
import type { Logger } from "./logger.js";
import type { PluginConfig } from "./config.js";
import { type CommandExecuteOutput } from "./commands/suppress.js";
export declare function getLastUserSessionId(messages: WithParts[]): string | undefined;
export declare function createChatMessageTransformHandler(client: any, stateManager: SessionStateManager, logger: Logger, config: PluginConfig, workingDirectory?: string): (_input: {}, output: {
    messages: WithParts[];
}) => Promise<void>;
export declare function createCommandExecuteHandler(client: any, stateManager: SessionStateManager, logger: Logger, config: PluginConfig): (input: {
    command: string;
    sessionID: string;
    arguments: string;
}, output: CommandExecuteOutput) => Promise<void>;
export declare function createSessionForkHandler(stateManager: SessionStateManager, logger: Logger): (input: {
    sourceSessionID: string;
    targetSessionID: string;
    cutoffMessageID?: string;
    messageIDMap: Record<string, string>;
    toolIDsByMessageID: Record<string, string[]>;
    childSessionIDMap: Record<string, string>;
}) => Promise<void>;
//# sourceMappingURL=hooks.d.ts.map