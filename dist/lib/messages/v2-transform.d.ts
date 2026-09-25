import type { Logger } from "../logger.js";
import type { SessionState, WithParts } from "../state/index.js";
interface ModelPart extends Record<string, unknown> {
    type: string;
}
export interface ModelMessage extends Record<string, unknown> {
    id?: string;
    role: string;
    content: ModelPart[];
}
export declare function transformV2Messages(raw: WithParts[], state: SessionState, logger: Logger, modelMessages: readonly ModelMessage[]): ModelMessage[];
export {};
//# sourceMappingURL=v2-transform.d.ts.map