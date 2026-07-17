// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from compress-map.md by scripts/generate-prompts.ts
// To modify, edit compress-map.md and run `npm run generate:prompts`
export const COMPRESS_MAP = `Do not call this tool autonomously. Tool availability alone is not authorization. Call it only when the current turn contains either a manual/plugin-initiated compression-management reminder or an explicit user request in the current message to inspect or compress context. Do not infer authorization from context size, task length, or perceived usefulness.

Call \`compress_map\` before \`compress\`. It returns a compact \`<compress-context-map>\` whose numeric entries are uncompressed messages, grouped numeric labels are inclusive contiguous display ranges, \`[bN]\` labels are existing compressed blocks, and \`[protected active tail]\` entries are unavailable to automatic compression.

The successfully returned map is atomically pinned as the current turn's sole execution source of truth. During an explicitly user-authorized normal turn, the current visible user request and subsequent in-progress agent/tool activity are excluded from selectable history. A later successful call replaces the one pin; no history accumulates. Reasoning and other tool calls may occur before \`compress\` without changing the pin.

When compression is authorized, default to one block covering the entire eligible uncompressed range after the newest \`[bN]\`. During automatic management, end immediately before \`[protected active tail]\`; during manual or explicitly user-authorized normal work, include every numeric entry unless the user explicitly requested a narrower range. Do not arbitrarily stop at one completed phase or branch. Leave existing \`[bN]\` blocks untouched unless the user explicitly requested consolidation.

If this call fails, no new map became authoritative. Read the diagnostic rather than guessing. The last successfully returned map from this same active turn, if any, remains pinned.
`;
//# sourceMappingURL=compress-map.generated.js.map