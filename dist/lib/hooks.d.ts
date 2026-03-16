import type { SessionState, WithParts } from "./state";
import type { Logger } from "./logger";
import type { PluginConfig } from "./config";
export declare function createChatMessageTransformHandler(client: any, state: SessionState, logger: Logger, config: PluginConfig): (_input: {}, output: {
    messages: WithParts[];
}) => Promise<void>;
export declare function createCommandExecuteHandler(client: any, state: SessionState, logger: Logger, config: PluginConfig): (input: {
    command: string;
    sessionID: string;
    arguments: string;
}, _output: {
    parts: any[];
}) => Promise<void>;
//# sourceMappingURL=hooks.d.ts.map