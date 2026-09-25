<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user ran `/compress manage`. Preserve enough context for another agent to pursue the same intended outcome without reinterpreting the user's decisions. Compression is context maintenance, not task completion.

Follow any `<user-message>` guidance for this request without sacrificing truthfulness. Call `compress` once with `summary` and `topic`. Selection is automatic: existing blocks are excluded while preserving the newest configured execution steps verbatim.

Before compression, update applicable existing durable documentation only for verified facts, settled decisions, or state that actually changed, and only when the task authorizes those edits. Follow the project's documentation conventions; do not create reports, logs, or new continuity documents merely for compression. If documentation is already current or the user requested no edits, skip that work. Read-only agents return candidate findings to the parent; lack of write authority must not block compression.

Summary guidance (use short headings where helpful; omit empty sections):
- User intent: the ultimate outcome and newest active request, including corrections to earlier direction.
- Decisions and boundaries: confirmed requirements, constraints, permissions, and agreed protocols. Separate user decisions from your assumptions, proposals, and unresolved discussion; compression grants no new authority.
- Current state: completed work with its evidence, incomplete work, material failures or uncertainty, and whether a final response was already delivered.
- Continuation: the approach being pursued and the next concrete action, if one exists. Preserve relevant running jobs or subagents and their IDs; check their status rather than launching duplicates.
- References: exact paths, commands, identifiers, and findings needed to continue without repeating investigation.

Keep a compact handoff, not a transcript. Preserve decision-relevant rationale and evidence, not every conversational exchange or raw output. Later evidence supersedes stale plans; never invent facts, approvals, results, or completion. The retained recent execution steps may further update the summary.

A success receipt confirms a durable save and an active fold; do not compress again this turn. Follow the user's requested next step and preserve the actual task disposition: continue authorized active work, but do not reopen completed work, duplicate a final response, or manufacture work while awaiting the user.
A failure means nothing was compressed. Surface the exact diagnostic before deciding whether a retry is warranted.
</system-reminder>
