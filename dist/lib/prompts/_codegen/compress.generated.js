// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from compress.md by scripts/generate-prompts.ts
// To modify, edit compress.md and run `npm run generate:prompts`
export const COMPRESS = `Use this tool during a user-initiated \`/compress manage\` turn to replace completed conversation ranges with stored summaries.

One range per call.

Args:
\`from\`: Start entry from the latest \`<compress-context-map>\` or returned map snapshot. Accepts numeric indexes, grouped numeric labels like \`"2-4"\`, or block ids like \`"b1"\`.
\`to\`: End entry from the latest \`<compress-context-map>\` or returned map snapshot. Inclusive.
\`summary\`: Replacement summary for the NEW material in that selected span.
\`topic\`: Short display label for the resulting block.

Range mechanics:
- A range covers whole map entries from \`from\` through \`to\`.
- If the range includes existing \`[bN]\` blocks, their stored summaries are already preserved by the tool. Write \`summary\` for the new material you are adding or condensing now.
- Prefer stacking topical blocks. Reuse an existing \`[bN]\` block only when it is outdated or needs to merge with adjacent same-topic work.
- Do not merge unrelated phases just because they are nearby.

Turn protocol:
- Keep the whole turn to 2 blocks when possible; 3 max.
- Compression 1: compress completed conversation into 1-2 new blocks; 3 max if needed.
- Later compressions: leave older dense \`[bN]\` archive blocks alone, fold the blocks created on the previous compression turn into one dense block, then compress newly completed work into 1-2 new blocks.

Density guidance:
- Older or less-relevant completed work should be terse.
- Recent completed work should keep more fidelity.
- Leave the active tail alone.

Each call rewrites history and invalidates cache from that point, so use as few calls as possible.

If more completed work needs compression, call \`compress\` again using the fresh \`<compress-context-map>\` returned by the previous call. Do not use it outside explicit user-requested context management.
`;
//# sourceMappingURL=compress.generated.js.map