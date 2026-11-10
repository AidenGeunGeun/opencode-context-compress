<system-reminder>
CONTEXT FOLD REQUESTED
{{reason}} It is due, not urgent, and not a change of task.

A fold replaces this whole conversation with one summary that you write. Nothing else stays visible. Project instructions (AGENTS.md, skills) load fresh afterwards; files and running jobs are untouched.

If a `<user-message>` block follows, it is the user's guidance for this fold.

In order:
1. Reach a clean stopping point: finish and verify the current step, leave nothing half-done, start no new large work.
{{documentation}}
3. Call `compress` once with the summary before this turn ends. Until you do, this request repeats and the context keeps growing.

Summary: what a capable colleague needs to take over right now, in English, as short as the live state allows.
- Request: the user's goal and newest request, quoted where the wording matters.
- Decisions and limits: what the user decided or ruled out, apart from your own assumptions.
- State: done and verified (with evidence), in progress, failed or uncertain.
- Next step: the next action, or that the work is finished or waiting. Name running jobs and subagents by ID.
- References: exact paths, commands, identifiers.
Leave out what instructions or documentation already say, history that no longer matters, and stale parts of an earlier summary. Never invent facts or completion.

After the fold, continue active work from the summary without announcing it; leave finished or waiting work alone. If the call fails, report the error and do not retry.
</system-reminder>
