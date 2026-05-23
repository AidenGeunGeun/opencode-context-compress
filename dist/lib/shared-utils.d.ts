import { SessionState, WithParts } from "./state/index.js";
export declare const isMessageCompacted: (state: SessionState, msg: WithParts) => boolean;
export declare const getLastUserMessage: (messages: WithParts[], startIndex?: number) => WithParts | null;
//# sourceMappingURL=shared-utils.d.ts.map