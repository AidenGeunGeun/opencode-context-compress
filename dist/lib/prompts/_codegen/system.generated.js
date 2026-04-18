// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from system.md by scripts/generate-prompts.ts
// To modify, edit system.md and run `npm run generate:prompts`
export const SYSTEM = `<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user explicitly ran \`/compress manage\`.
<compress_map>Use \`compress_map\` to read the current context map.</compress_map>
<compress>Use \`compress\` to replace one completed range per call with a topical block. One range per call; if more completed work needs compression, call \`compress\` again using the returned map.</compress>
Older or less-relevant completed work should be terse.
Recent completed work should keep more fidelity.
Do not touch the active tail; decide that boundary from the conversation itself.
Prefer stacking new topical blocks over rewrapping good existing blocks.
Use compression tools only inside this \`/compress manage\` turn.
</system-reminder>
`;
//# sourceMappingURL=system.generated.js.map