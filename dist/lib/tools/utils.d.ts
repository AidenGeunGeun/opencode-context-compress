import type { WithParts } from "../state";
export declare function getCompletedToolOutputText(part: {
    tool?: unknown;
    callID?: unknown;
}, output: unknown, options?: {
    stringifyNonString?: boolean;
    requireTruthy?: boolean;
}): string | undefined;
export declare function extractMessageContent(msg: WithParts): string;
export declare function collectToolIdsInRange(messages: WithParts[], startIndex: number, endIndex: number): string[];
export declare function collectContentInRange(messages: WithParts[], startIndex: number, endIndex: number): string[];
//# sourceMappingURL=utils.d.ts.map