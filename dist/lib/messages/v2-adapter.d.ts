import type { WithParts } from "../state/types.js";
export interface V2SessionSelection {
    readonly agent?: string;
    readonly model?: {
        readonly providerID: string;
        readonly id: string;
        readonly variant?: string;
    };
}
export declare function adaptProjectedMessages(sessionID: string, values: readonly unknown[], selection?: V2SessionSelection): WithParts[];
//# sourceMappingURL=v2-adapter.d.ts.map