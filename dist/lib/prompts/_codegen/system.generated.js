// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from system.md by scripts/generate-prompts.ts
// To modify, edit system.md and run `npm run generate:prompts`
export const SYSTEM = `<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user ran \`/compress manage\`.

Use the included map snapshot.

<compress>Call \`compress\` exactly once to fold completed, no-longer-active context into one durable block.</compress>
<compress_map>Do not call \`compress_map\` in the normal path; use it only if the included map is missing/stale, or the user explicitly asked to inspect/debug the map.</compress_map>

Range:
- Compress the oldest uncompressed completed span since the last \`[bN]\`; on the first compression, fold completed history before the active tail.
- Default append-only: do not include existing \`[bN]\` blocks. Include/rewrite blocks only when the user explicitly asked to consolidate or recompress them.
- Leave the active tail/current unresolved work visible.

Summary:
- Dense, high-detail, future-useful: preserve WHY, decisions, constraints, gotchas, commands/results, file paths, IDs, and open follow-ups.
- Drop only noise: raw logs, repeated reads, abandoned dead ends, obvious chatter.
- Prefer enough detail over terse lossiness.

After \`compress\` succeeds, the fold is already active; no further map or compression calls are needed this turn.
</system-reminder>
`;
//# sourceMappingURL=system.generated.js.map