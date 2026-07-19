<system-reminder>
AUTOMATIC CONTEXT COMPRESSION REQUIRED
This session's working context reached ~{{context_tokens}} tokens; its effective threshold is ~{{threshold_tokens}} tokens ({{threshold_reason}}). The threshold says nothing by itself about whether the task is active, blocked, complete, or awaiting the user. Compression is context maintenance, not a task-status transition.

For each selected history span, compression replaces the original model-visible messages with one durable summary block. That summary becomes the only model-visible representation of the span available to future turns, so it must preserve enough truthful detail for another agent to understand what happened and continue correctly.

The same map-first tools may be used agentically during normal work; this automatic management turn requires using them now before restoring the session's latest evidenced disposition.

Procedure:
<compress_map>1. Call `compress_map` first and inspect the snapshot it returns.</compress_map>
<compress>2. Call `compress` once with labels from that exact snapshot. Reasoning or other tool calls between these steps do not invalidate the snapshot.</compress>

Map grammar:
- Numeric entries are uncompressed messages. Grouped labels such as `[2-4]` are inclusive contiguous display ranges. `[bN]` entries are already-compressed immutable blocks.
- Never select an entry labeled `[protected active tail]`; it contains recent execution state needed to continue.

Range safety:
- Compress the entire eligible uncompressed range in ONE call, not a convenient partial phase or branch. Starting after the newest `[bN]`, select every numeric entry through the entry immediately before `[protected active tail]`.
- The protected tail is the only default exclusion for current work. Do not preserve an additional large uncompressed tail. The protected tail remains visible after compression: preserve enough bridge context to understand it, avoid unnecessary duplication, and never let the summary contradict its later evidence.
- Default append-only: leave `[bN]` blocks untouched unless the user explicitly requested consolidation.

Summary fidelity:
- Write for a future agent that will not have the original messages from the selected span. This is a continuation record, not a progress update or a report about compression. Preserve what happened, why the state changed, what is established, what remains unresolved, and where the task currently stands.
- Prefer factual completeness and continuity over brevity. A longer summary is acceptable when the detail is load-bearing. Preserve, when present and relevant, the exact user objective and WHY; the controlling spec or task contract; confirmed decisions, constraints, and materially relevant rejected alternatives; the chronological implementation or investigation trajectory; changed files and artifacts; load-bearing commands and concrete results; failures, fixes, and re-validation; review or audit findings and their disposition; and work that is completed, pending, blocked, or ruled out.
- Reconcile the selected history chronologically and against the later protected tail. Later evidence supersedes earlier plans, todo lists, tentative conclusions, and pending-work statements. Do not carry work forward as pending when later evidence shows it completed, and do not claim completion without evidence.
- Preserve the latest known task disposition: in progress, blocked, complete, or awaiting the user. Preserve whether a final response, report, or handoff was already delivered and the outcome it stated. Include an exact next action only when one genuinely exists; do not invent one for completed work.
- Truthfulness is the highest priority. Never invent or infer unsupported facts, actions, file changes, command results, tests, approvals, or completion. If evidence is missing, conflicting, ambiguous, or unverified, say so explicitly rather than resolving it by guess.
- Remove only replaceable noise, repetition, and non-load-bearing chatter. When uncertain whether a detail is needed for correct continuation, retain it. Use whatever clear structure best fits the session; no fixed heading template is required.

Result handling:
- A success receipt means the state was durably saved and the fold is already active. Make no more compression calls this turn and do not stop merely to report that compression happened. Restore the latest truthful disposition shown by the history and protected tail: continue immediately only when work was genuinely active; do not reopen work or duplicate a final response when it was complete or awaiting the user; preserve an unresolved blocker; and do not guess when the disposition is uncertain.
- A failure means nothing was compressed. Read the exact diagnostic, do not guess a smaller or differently formatted range, and call `compress_map` again only when instructed before retrying with labels from its returned snapshot.
</system-reminder>
