// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from compress-map.md by scripts/generate-prompts.ts
// To modify, edit compress-map.md and run `npm run generate:prompts`
export const COMPRESS_MAP = `Use this tool during a user-initiated \`/compress manage\` turn to fetch the current compression map.

The result is a compact \`<compress-context-map>\` snapshot with numeric entries, \`[bN]\` blocks, previews, per-entry token estimates, and a totals footer.

Use it at the start of context management or any time you want a fresh snapshot. After a \`compress\` call, prefer the refreshed map returned by that tool as the next source of truth. The map does not mark an active tail for you; decide what to leave uncompressed from the conversation itself.

Follow the same sparse-block protocol for the turn: aim for 2 blocks total, 3 max.

Do not use this tool outside explicit user-requested context management.
`;
//# sourceMappingURL=compress-map.generated.js.map