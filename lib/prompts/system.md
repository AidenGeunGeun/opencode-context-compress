<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user ran `/compress manage`. For each selected history span, compression replaces the original model-visible messages with one durable summary block. That summary becomes the only model-visible representation of the span available to future turns, so it must preserve enough truthful detail for another agent to understand what happened and continue correctly. Compression itself does not imply that the underlying task is active, incomplete, blocked, or complete.

The same map-first tools may also be used agentically during normal work; this reminder asks you to use them now.

If a `<user-message>` block is present, it contains the user's specific instructions for this compression turn. Follow it as closely as possible while preserving the map-first procedure, protected context, and safety constraints below.

Procedure:
<compress_map>1. Call `compress_map` first. Inspect the snapshot it returns before choosing a range.</compress_map>
<compress>2. Call `compress` once with labels from that exact snapshot. The snapshot remains authoritative even if you reason or use other tools between these calls.</compress>

Map grammar:
- Numeric entries are uncompressed messages. A grouped label such as `[2-4]` displays an inclusive contiguous run and may be used as a boundary.
- `[bN]` entries are already-compressed blocks. Entries marked `[protected active tail]` cannot be selected during automatic management.

Range safety:
- Default to the entire eligible uncompressed range in ONE call, not a convenient partial phase or branch. Select every numeric entry after the newest `[bN]`, from the first such entry through the final numeric entry in the map, unless a `<user-message>` explicitly requests a narrower range.
- Do not leave a large active-work tail merely because some work is ongoing. If the selected span contains current work, preserve its exact evidenced state and a real next action when one exists. The current management turn itself is already outside the map.
- Default append-only: leave existing `[bN]` blocks immutable. Consolidate old blocks only when the user explicitly asked for that.

Summary fidelity:
- Write for a future agent that will not have the original messages from the selected span. This is a continuation record, not a progress update or a report about compression. Preserve what happened, why the state changed, what is established, what remains unresolved, and where the task currently stands.
- Prefer factual completeness and continuity over brevity. A longer summary is acceptable when the detail is load-bearing. Preserve, when present and relevant, the exact user objective and WHY; the controlling spec or task contract; confirmed decisions, constraints, and materially relevant rejected alternatives; the chronological implementation or investigation trajectory; changed files and artifacts; load-bearing commands and concrete results; failures, fixes, and re-validation; review or audit findings and their disposition; and work that is completed, pending, blocked, or ruled out.
- Reconcile the chronology before writing. Later evidence supersedes earlier plans, todo lists, tentative conclusions, and pending-work statements. Do not carry work forward as pending when later evidence shows it completed, and do not claim completion without evidence.
- Preserve the latest known task disposition: in progress, blocked, complete, or awaiting the user. Preserve whether a final response, report, or handoff was already delivered and the outcome it stated. Include an exact next action only when one genuinely exists; do not invent one for completed work.
- Truthfulness is the highest priority. Never invent or infer unsupported facts, actions, file changes, command results, tests, approvals, or completion. If evidence is missing, conflicting, ambiguous, or unverified, say so explicitly rather than resolving it by guess.
- Remove only replaceable noise, repetition, and non-load-bearing chatter. When uncertain whether a detail is needed for correct continuation, retain it. Use whatever clear structure best fits the session; no fixed heading template is required.

Result handling:
- A success receipt means the state was durably saved and the fold is already active. Do not call either compression tool again this turn. Do not reopen completed work or invent continuation merely because compression occurred.
- A failure means nothing was compressed. Read the exact diagnostic; do not guess progressively smaller or reformatted ranges. If instructed, call `compress_map` again and retry using labels from the newly returned map.
</system-reminder>
