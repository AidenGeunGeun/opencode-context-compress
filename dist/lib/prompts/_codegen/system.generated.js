// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from system.md by scripts/generate-prompts.ts
// To modify, edit system.md and run `npm run generate:prompts`
export const SYSTEM = `<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user explicitly ran \`/compress manage\`.

This rewrites what the model sees on every future turn until the session reloads. Folded content won't be visible in detail again — be deliberate.

<compress_map>Use \`compress_map\` to read the current context map.</compress_map>
<compress>Use \`compress\` once to fold the completed working context into a single new block.</compress>

Summaries should capture the WHY plus any load-bearing details — decisions and reasoning, constraints, gotchas, working commands, key paths, lessons, anything future-you would need to re-derive. Drop only the noise — raw tool output, exploratory greps, abandoned hypotheses, routine reads. Detail is cheap compared to tool calls; when in doubt, keep more.

- One new block this turn: fold the completed work that piled up since the last block into a single new \`[bN]\`, appended after the existing blocks (on the first compression, fold all completed conversation before the active tail).
- Compress the oldest uncompressed content first. \`[b0]\` = oldest fold, \`[b1]\` next — chronological IDs so each turn appends cleanly without disturbing earlier blocks.
- Never re-compress or rewrap existing \`[bN]\` blocks on a normal turn — only consolidate older blocks if the user explicitly asks you to.
- Leave the active tail alone — the work still in progress.
- Why append-only: untouched older blocks keep their cached tokens, so only the newest slice is re-encoded; rewriting an older block invalidates everything after it.
- Use compression tools only inside this \`/compress manage\` turn.
</system-reminder>
`;
//# sourceMappingURL=system.generated.js.map