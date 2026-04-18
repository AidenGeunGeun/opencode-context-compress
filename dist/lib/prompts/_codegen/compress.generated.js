// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from compress.md by scripts/generate-prompts.ts
// To modify, edit compress.md and run `npm run generate:prompts`
export const COMPRESS = `Use this tool during a user-initiated \`/compress manage\` turn to replace completed conversation ranges with stored summaries.

\`ranges\` is an array of compression requests.

Each range has:
\`from\`: Start entry from the latest \`<compress-context-map>\` or returned map snapshot. Accepts numeric indexes, grouped numeric labels like \`"2-4"\`, or block ids like \`"b1"\`.
\`to\`: End entry from the latest \`<compress-context-map>\` or returned map snapshot. Inclusive.
\`summary\`: Replacement summary for the NEW material in that selected span.
\`topic\`: Short display label for the resulting block.

Range mechanics:
- A range covers whole map entries from \`from\` through \`to\`.
- If the range includes existing \`[bN]\` blocks, their stored summaries are already preserved by the tool. Write \`summary\` for the new material you are adding or condensing now.
- Prefer stacking topical blocks. Reuse an existing \`[bN]\` block only when it is outdated or needs to merge with adjacent same-topic work.
- Do not merge unrelated phases just because they are nearby.

Density guidance:
- Older or lower-relevance completed work can be terse.
- Recent completed work should keep more fidelity.
- Leave the active tail alone.

This tool may be called multiple times in the same management turn. On success it returns a fresh \`<compress-context-map>\` snapshot so you can keep iterating. Do not use it outside explicit user-requested context management.
`;
//# sourceMappingURL=compress.generated.js.map