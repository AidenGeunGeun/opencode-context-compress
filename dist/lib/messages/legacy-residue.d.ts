import type { WithParts } from "../state/index.js";
export interface LegacyResidueSuppressionPlan {
    suppressedMessageIds: Set<string>;
    retainedTextByMessageId: Map<string, string>;
}
export declare function buildLegacyResidueSuppressionPlan(rawMessages: WithParts[]): LegacyResidueSuppressionPlan;
//# sourceMappingURL=legacy-residue.d.ts.map