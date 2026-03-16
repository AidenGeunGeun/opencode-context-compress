import type { SessionState, WithParts } from "../state";
import type { Logger } from "../logger";
export declare const applyCompressTransforms: (state: SessionState, logger: Logger, messages: WithParts[]) => void;
export interface TransformMessagesForSearchResult {
    transformed: WithParts[];
    syntheticMap: Map<string, SessionState["compressSummaries"][number]>;
}
export declare const transformMessagesForSearch: (rawMessages: WithParts[], state: SessionState, logger: Logger) => TransformMessagesForSearchResult;
//# sourceMappingURL=compress-transform.d.ts.map