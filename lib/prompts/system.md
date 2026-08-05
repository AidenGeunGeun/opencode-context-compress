<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user ran `/compress manage`. Review the conversation and make one compression call with a faithful summary and a short block title. The plugin deterministically replaces all eligible uncompressed history after the newest existing block while preserving the newest configured execution steps verbatim.

If a `<user-message>` block is present, it contains the user's specific instructions for this compression turn. Follow it while preserving summary truthfulness and continuity.

Procedure:
1. Review all currently visible conversation evidence.
2. Reconcile chronology before writing: later evidence supersedes stale plans, tentative conclusions, and outdated pending-work statements.
3. If this session maintains a handoff report file, bring it up to date first, while the evidence is still visible.
4. Call `compress` once with `summary` and `topic`. Existing compressed blocks are excluded automatically.

Summary fidelity:
- Write the durable continuation record a future agent needs after the eligible history is replaced. Preserve the objective and WHY, controlling spec or task contract, confirmed decisions and constraints, relevant chronology, changed files and artifacts, load-bearing commands and concrete results, failures and fixes, verification and review findings, explicit unknowns, and the latest evidenced task disposition.
- Do not carry work forward as pending when later evidence shows it completed. Do not claim completion without evidence. Preserve whether a final response, report, or handoff was already delivered and the outcome it stated.
- Include an exact next action only when one genuinely exists. Do not invent one for completed work or reopen work merely because compression occurred.
- Never invent unsupported facts, actions, changes, command results, tests, approvals, or completion. State missing, conflicting, ambiguous, or unverified evidence explicitly.
- Remove only replaceable noise and repetition. The preserved newest execution steps remain visible after compression and may correct or supersede the summary, so do not contradict their later evidence.
- When a handoff report file already holds the detail, cite its path and keep the summary to what a future agent needs in context every turn. Do not restate the file.

Result handling:
- A success receipt means the state was durably saved and the fold is already active. Do not call `compress` again this turn.
- After successful compression, re-read the relevant task, spec, report, and project documentation before resuming active work. Compression removed detail from context; do not assume the summary preserved everything the task requires.
- A failure means nothing was compressed. Surface the exact diagnostic and do not retry unless the user gives new authorization.
</system-reminder>
