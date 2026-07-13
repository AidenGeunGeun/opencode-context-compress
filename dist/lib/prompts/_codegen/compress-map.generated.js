// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from compress-map.md by scripts/generate-prompts.ts
// To modify, edit compress-map.md and run `npm run generate:prompts`
export const COMPRESS_MAP = `Use this tool whenever context inspection or compression would help, either during normal work or inside a manual/plugin-initiated compression-management turn.

Call \`compress_map\` before \`compress\`. It returns a compact \`<compress-context-map>\` whose numeric entries are uncompressed messages, grouped numeric labels are inclusive contiguous display ranges, \`[bN]\` labels are existing compressed blocks, and \`[protected active tail]\` entries are unavailable to automatic compression.

The successfully returned map is atomically pinned as the current turn's sole execution source of truth. During normal work, the current visible user request and subsequent in-progress agent/tool activity are excluded from selectable history. A later successful call replaces the one pin; no history accumulates. Reasoning and other tool calls may occur before \`compress\` without changing the pin.

Choose the oldest completed uncompressed span and leave current work visible. Default append-only: leave \`[bN]\` blocks untouched unless the user explicitly requested consolidation.

If this call fails, no new map became authoritative. Read the diagnostic rather than guessing. The last successfully returned map from this same active turn, if any, remains pinned.
`;
//# sourceMappingURL=compress-map.generated.js.map