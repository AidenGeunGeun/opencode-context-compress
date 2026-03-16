import type { Logger } from "../logger";
import type { SessionState } from "../state";
import type { PluginConfig } from "../config";
export declare function sendCompressNotification(client: any, logger: Logger, config: PluginConfig, state: SessionState, sessionId: string, toolIds: string[], itemCount: number, topic: string, summary: string, startResult: any, endResult: any, totalMessages: number, params: any, rangeTokenEstimate?: number): Promise<boolean>;
export declare function sendIgnoredMessage(client: any, sessionID: string, text: string, params: any, logger: Logger): Promise<void>;
//# sourceMappingURL=notification.d.ts.map