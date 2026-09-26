<system-reminder>
AUTOMATIC CONTEXT COMPRESSION DUE
Working context reached ~{{context_tokens}} tokens; the effective threshold is ~{{threshold_tokens}} tokens ({{threshold_reason}}). Automatic compression has been invoked for this turn. It is due, not urgent: preserve the user's intent and current work so execution can continue across compression; this is not a task-status transition.

First bring the work in progress to a clean stopping point: finish and verify the current step, and leave no edit, command, or line of reasoning half-done. Do not start new large work. A deliberate wrap-up produces a better handoff than a hurried compression.

Then call `compress` once, before this turn ends, with a faithful `summary` and short `topic`. Selection is automatic: existing blocks are excluded and the newest configured execution steps remain verbatim.

As part of the wrap-up, update applicable existing durable documentation only for verified facts, settled decisions, or state that actually changed, and only when the task authorizes those edits. Follow the project's documentation conventions; do not create reports, logs, or new continuity documents merely for compression. If documentation is already current or the user requested no edits, skip that work. Read-only agents return candidate findings to the parent; lack of write authority must not block compression.

Summary guidance (use short headings where helpful; omit empty sections):
- User intent: the ultimate outcome and newest active request, including corrections to earlier direction.
- Decisions and boundaries: confirmed requirements, constraints, permissions, and agreed protocols. Separate user decisions from your assumptions, proposals, and unresolved discussion; compression grants no new authority.
- Current state: completed work with its evidence, incomplete work, material failures or uncertainty, and whether a final response was already delivered.
- Continuation: the approach being pursued and the next concrete action, if one exists. Preserve relevant running jobs or subagents and their IDs; check their status rather than launching duplicates.
- References: exact paths, commands, identifiers, and findings needed to continue without repeating investigation.

Keep a compact handoff, not a transcript. Preserve decision-relevant rationale and evidence, not every conversational exchange or raw output. Later evidence supersedes stale plans; never invent facts, approvals, results, or completion. The retained recent execution steps may further update the summary.

A success receipt confirms a durable save and an active fold. Make no more compression calls this turn. Continue immediately only when work was genuinely active, within the agreed scope and existing authority; do not pause merely to report that compression finished. Preserve completed or awaiting-user status instead of reopening work or duplicating a final response.
A failure means nothing was compressed. Surface the exact diagnostic and do not retry automatically.
</system-reminder>
