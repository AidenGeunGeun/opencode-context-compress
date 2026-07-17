// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from compress.md by scripts/generate-prompts.ts
// To modify, edit compress.md and run `npm run generate:prompts`
export const COMPRESS = `Do not call this tool autonomously. Tool availability alone is not authorization, and neither is a prior \`compress_map\` call. Call it only when the current turn contains either a manual/plugin-initiated compression-management reminder or an explicit user request in the current message to compress context, and only after \`compress_map\` has successfully returned the authoritative snapshot for this turn. This tool folds one selected historical span into one durable summary block.

Args:
\`from\`: Inclusive start label from the most recently returned current-turn map: a numeric entry, grouped numeric label such as \`"2-4"\`, or \`[bN]\` block label.
\`to\`: Inclusive end label from that same pinned map.
\`summary\`: Dense replacement preserving the objective and WHY, decisions, constraints, edits, paths, commands/results, failures, pending work, and exact next action.
\`topic\`: Short display label for the stored block.

- Default to the entire eligible uncompressed range after the newest \`[bN]\` in one call. During automatic management, end immediately before \`[protected active tail]\`; otherwise include every numeric entry unless the user explicitly requested a narrower range. Do not arbitrarily stop at one phase or branch.
- Default append-only: do not include existing \`[bN]\` blocks. Consolidate contiguous old blocks only when the user explicitly requested it.
- Never select \`[protected active tail]\` during automatic management.
- A recent successful compression may temporarily block another model-initiated compression; only an explicit user \`/compress manage\` overrides that cooldown.
- A success receipt means the save is durable and the fold is already active. Do not call \`compress\` or \`compress_map\` again that turn; after automatic compression, immediately resume the original task.
- A failure means nothing changed. Follow its exact diagnostic; do not guess smaller or reformatted ranges. Refresh with \`compress_map\` when instructed and retry only with labels it returns.
`;
//# sourceMappingURL=compress.generated.js.map