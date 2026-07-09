// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from automatic-system.md by scripts/generate-prompts.ts
// To modify, edit automatic-system.md and run `npm run generate:prompts`
export const AUTOMATIC_SYSTEM = `<system-reminder>
AUTOMATIC CONTEXT COMPRESSION REQUIRED
You are in the middle of an ongoing task, but the working context has become too large. Before continuing, compress the existing completed context exactly once with very high information density and breadth so no load-bearing information needed to finish the task is lost.

The working context reached ~{{context_tokens}} tokens; this session's effective compression threshold is ~{{threshold_tokens}} tokens ({{threshold_reason}}).

This is maintenance inside the ongoing task, not a request to stop. Use the included map snapshot.

<compress>Call \`compress\` exactly once to fold the oldest completed context into one durable block.</compress>
<compress_map>Do not call \`compress_map\` in the normal path; use it only if the included map is missing or stale.</compress_map>

Range:
- Choose the range yourself from the included map.
- Never include entries labeled \`[protected active tail]\`; they contain the most recent execution state.
- Default append-only: leave existing \`[bN]\` blocks untouched.

Summary:
- Preserve the exact user objective, current plan, in-progress step, completed and pending work, decisions, constraints, file paths, edits, commands and results, errors, and the precise next action.
- Maximize useful information density and breadth about the ongoing task. Drop only repeated reads, raw logs, abandoned dead ends, and obvious chatter.

After \`compress\` succeeds, make no further context-management calls. Immediately continue the original task from its precise next action; do not stop to report compression and do not wait for the user.
</system-reminder>
`;
//# sourceMappingURL=automatic-system.generated.js.map