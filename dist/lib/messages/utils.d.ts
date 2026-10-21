import type { WithParts } from "../state/index.js";
export declare const COMPRESS_SUMMARY_PREFIX = "[Compressed conversation block]\n\n";
export declare const createSyntheticUserMessage: (baseMessage: WithParts, content: string, variant?: string, stableSeed?: string) => WithParts;
export declare const isIgnoredUserMessage: (message: WithParts) => boolean;
//# sourceMappingURL=utils.d.ts.map