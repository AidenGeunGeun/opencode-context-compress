// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from system.md by scripts/generate-prompts.ts
// To modify, edit system.md and run `npm run generate:prompts`
export const SYSTEM = `<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user explicitly ran \`/compress manage\`.

This rewrites what the model sees on every future turn until the session reloads. Folded content won't be visible in detail again — be deliberate.

<compress_map>Use \`compress_map\` to read the current context map.</compress_map>
<compress>Use \`compress\` to replace one completed range per call with a topical block. One range per call; if more completed work needs compression, call \`compress\` again using the returned map.</compress>

Summaries should capture the WHY plus any load-bearing details — decisions and reasoning, constraints, gotchas, working commands, key paths, lessons, anything future-you would need to re-derive. Drop only the noise — raw tool output, exploratory greps, abandoned hypotheses, routine reads. Detail is cheap compared to tool calls; when in doubt, keep more.

- Compress oldest content first. \`[b0]\` = oldest fold, \`[b1]\` next. Keeps IDs in chronological order so future turns append cleanly without disturbing earlier blocks.
- Turn budget: 2 blocks, 3 max. Each \`compress\` call invalidates cache from that point.
- No \`[bN]\` blocks yet → compress completed conversation into 1-2 new blocks.
- \`[bN]\` blocks exist → leave older ones alone, fold the newest narrow blocks into one, then compress the rest into 1-2 new blocks.
- Older or less-relevant completed work should be terse.
- Recent completed work should keep more fidelity.
- Leave the active tail alone.
- Stack new topical blocks; don't rewrap good existing ones.
- Use compression tools only inside this \`/compress manage\` turn.
</system-reminder>
`;
//# sourceMappingURL=system.generated.js.map