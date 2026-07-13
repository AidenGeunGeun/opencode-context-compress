// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from system.md by scripts/generate-prompts.ts
// To modify, edit system.md and run `npm run generate:prompts`
export const SYSTEM = `<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user ran \`/compress manage\`. Compression replaces completed historical work with one dense, durable summary so context space is recovered without losing information needed to continue. The same map-first tools may also be used agentically during normal work; this reminder asks you to use them now.

If a \`<user-message>\` block is present, it contains the user's specific instructions for this compression turn. Follow it as closely as possible while preserving the map-first procedure, protected context, and safety constraints below.

Procedure:
<compress_map>1. Call \`compress_map\` first. Inspect the snapshot it returns before choosing a range.</compress_map>
<compress>2. Call \`compress\` once with labels from that exact snapshot. The snapshot remains authoritative even if you reason or use other tools between these calls.</compress>

Map grammar:
- Numeric entries are uncompressed messages. A grouped label such as \`[2-4]\` displays an inclusive contiguous run and may be used as a boundary.
- \`[bN]\` entries are already-compressed blocks. Entries marked \`[protected active tail]\` cannot be selected during automatic management.

Range safety:
- Compress the oldest completed uncompressed span first; leave unresolved or current work visible.
- Default append-only: leave existing \`[bN]\` blocks immutable. Consolidate old blocks only when the user explicitly asked for that.

Summary quality:
- Preserve the objective and WHY, decisions, constraints, edits, paths, commands and results, failures, pending work, and exact next action. Remove only replaceable noise; when uncertain, retain more detail.

Result handling:
- A success receipt means the state was durably saved and the fold is already active. Do not call either compression tool again this turn.
- A failure means nothing was compressed. Read the exact diagnostic; do not guess progressively smaller or reformatted ranges. If instructed, call \`compress_map\` again and retry using labels from the newly returned map.
</system-reminder>
`;
//# sourceMappingURL=system.generated.js.map