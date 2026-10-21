import type { Logger } from "../logger.js";
import type { SessionState } from "../state/index.js";
import type { PluginConfig } from "../config.js";
import { type PluginClient } from "../sdk/client.js";
import type { CompressToolContext } from "../tools/types.js";
export declare function sendSquashNotification(client: CompressToolContext["client"], logger: Logger, config: PluginConfig, sessionId: string, outcome: {
    oldFrom: string;
    oldTo: string;
    newLabel: string;
    topic: string;
    selectedBlocks: number;
    blocksBefore: number;
    blocksAfter: number;
    oldVisibleTokens: number;
    newVisibleTokens: number;
}): Promise<void>;
export declare function sendCompressNotification(client: PluginClient, logger: Logger, config: PluginConfig, state: SessionState, sessionId: string, toolIds: string[], itemCount: number, topic: string, summary: string, startResult: {
    messageIndex: number;
}, endResult: {
    messageIndex: number;
}, totalMessages: number, rangeTokenEstimate?: number): Promise<boolean>;
export declare function sendIgnoredMessage(client: PluginClient, sessionID: string, text: string, logger: Logger): Promise<void>;
//# sourceMappingURL=notification.d.ts.map