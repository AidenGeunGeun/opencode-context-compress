// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from automatic-system.md by scripts/generate-prompts.ts
// To modify, edit automatic-system.md and run `npm run generate:prompts`
export const AUTOMATIC_SYSTEM = `<system-reminder>
AUTOMATIC CONTEXT COMPRESSION REQUIRED
This session's working context reached ~{{context_tokens}} tokens; its effective threshold is ~{{threshold_tokens}} tokens ({{threshold_reason}}). Compression is context maintenance, not a task-status transition.

Review the conversation and call \`compress\` once with a faithful \`summary\` and short \`topic\`. The plugin deterministically replaces all eligible uncompressed history after the newest existing block, excludes existing blocks, and preserves the newest configured execution steps verbatim.

Summary fidelity:
- Reconcile chronology and the preserved recent evidence. Later evidence supersedes stale plans, tentative conclusions, and outdated pending-work statements.
- Preserve the objective and WHY, controlling spec or task contract, confirmed decisions and constraints, relevant chronology, changed files and artifacts, load-bearing commands and concrete results, failures and fixes, verification and review findings, explicit unknowns, any delivered final response or handoff, and the latest evidenced task disposition.
- Do not invent missing facts or completion. Do not carry completed work forward as pending. Include an exact next action only when one genuinely exists.
- The preserved newest execution steps remain visible after compression and may correct or supersede the summary, so do not contradict their later evidence.

Result handling:
- A success receipt means the state was durably saved and the fold is already active. Make no more compression calls this turn. Continue immediately only when work was genuinely active; do not reopen completed work, duplicate a final response, or invent continuation when the session was awaiting the user.
- A failure means nothing was compressed. Surface the exact diagnostic and do not retry automatically.
</system-reminder>
`;
//# sourceMappingURL=automatic-system.generated.js.map