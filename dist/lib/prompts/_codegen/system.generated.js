// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from system.md by scripts/generate-prompts.ts
// To modify, edit system.md and run `npm run generate:prompts`
export const SYSTEM = `<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user explicitly ran \`/compress manage\`.
<compress_map>Use \`compress_map\` to read the current context map.</compress_map>
<compress>Use \`compress\` to replace completed phases with topical blocks.</compress>
Older or less-relevant completed work should be terse.
Recent completed work should keep more fidelity.
Do not touch the active tail; decide that boundary from the conversation itself.
Prefer stacking new topical blocks over rewrapping good existing blocks.
Keep compression inside this turn only; do not use compression tools again unless the user asks.
</system-reminder>
`;
//# sourceMappingURL=system.generated.js.map