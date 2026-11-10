<system-reminder>
CONTEXT FOLD REQUESTED
{{reason}} It is due, not urgent, and it is not a change of task.

A fold replaces this whole conversation, including any earlier summary in it, with one summary that you write. Nothing else stays visible afterwards: no recent messages, tool results, or reasoning. The project's instructions (AGENTS.md, skills, tool descriptions) are loaded fresh after the fold, and files and running jobs are untouched.

If a `<user-message>` block follows this reminder, it is the user's guidance for this fold. Follow it.

Do these in order:

1. Bring the work in progress to a clean stopping point. Finish and verify the current step, leave no edit or command half-done, and start no new large work. A fold in the middle of a step loses the reasoning behind it.

{{documentation}}

3. Call `compress` once with the summary, before this turn ends. Without the call the context keeps growing: every step costs more, this request repeats, and the conversation eventually hits the model's limit.

The summary lets you continue after the fold as if nothing had interrupted you. Write what a capable colleague would need to take over this exact work right now. Use short headings and omit empty ones:

- Request: the user's goal and newest request, including corrections to earlier direction. Quote the user's wording where it matters.
- Decisions and limits: what the user decided, permitted, or ruled out, kept apart from your own assumptions and proposals. A fold grants no new authority.
- State: what is done and verified, with the evidence; what is in progress; what failed or is uncertain; and whether a final answer was already given.
- Next step: the next concrete action, or that the work is finished or waiting for the user. Name running jobs and subagents with their IDs so they are checked, not started twice.
- References: exact paths, commands, identifiers, and numbers needed to continue without repeating the investigation.

Leave these out:

- What the project's instructions or documentation already say. They are loaded fresh or one read away, and a copy in the summary goes stale while the original stays right. Name the file instead.
- History that no longer affects the next step: superseded plans, solved problems, the order in which things happened.
- Stale parts of an earlier summary. It is replaced too, so carry forward only what is still needed and merge it into the new one.

Write the summary in English, whatever language the conversation uses, and keep it as short as the live state allows: every later step reads it again. Never invent facts, approvals, results, or completion.

After a successful call the fold applies right after that step, and you continue from your summary. Continue active, authorized work without stopping to report that the fold finished; leave finished or waiting work as it is. If the call fails, nothing was folded: report the exact error and do not retry by yourself.
</system-reminder>
