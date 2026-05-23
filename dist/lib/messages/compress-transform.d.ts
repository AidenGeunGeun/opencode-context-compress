import type { SessionState, WithParts } from "../state/index.js";
import type { Logger } from "../logger.js";
export declare const applyCompressTransforms: (state: SessionState, logger: Logger, messages: WithParts[]) => void;
export interface TransformMessagesForSearchResult {
    transformed: WithParts[];
    syntheticMap: Map<string, SessionState["compressSummaries"][number]>;
}
interface ManagementTurnSuppressionPlan {
    suppressedMessageIds: Set<string>;
    retainedTextByMessageId: Map<string, string>;
}
export declare function buildManagementTurnSuppressionPlan(state: SessionState, rawMessages: WithParts[]): ManagementTurnSuppressionPlan;
export declare const transformMessagesForSearch: (rawMessages: WithParts[], state: SessionState, logger: Logger) => TransformMessagesForSearchResult;
export {};
//# sourceMappingURL=compress-transform.d.ts.map