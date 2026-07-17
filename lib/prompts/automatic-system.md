<system-reminder>
AUTOMATIC CONTEXT COMPRESSION REQUIRED
You are in the middle of an ongoing task, but its working context reached ~{{context_tokens}} tokens; this session's effective threshold is ~{{threshold_tokens}} tokens ({{threshold_reason}}). Compression is maintenance, not task completion: replace completed history with one dense, durable summary, then immediately resume the interrupted task.

The same map-first tools may be used agentically during normal work; this automatic management turn requires using them now before resuming the task.

Procedure:
<compress_map>1. Call `compress_map` first and inspect the snapshot it returns.</compress_map>
<compress>2. Call `compress` once with labels from that exact snapshot. Reasoning or other tool calls between these steps do not invalidate the snapshot.</compress>

Map grammar:
- Numeric entries are uncompressed messages. Grouped labels such as `[2-4]` are inclusive contiguous display ranges. `[bN]` entries are already-compressed immutable blocks.
- Never select an entry labeled `[protected active tail]`; it contains recent execution state needed to continue.

Range and summary:
- Compress the entire eligible uncompressed range in ONE call, not a convenient partial phase or branch. Starting after the newest `[bN]`, select every numeric entry through the entry immediately before `[protected active tail]`.
- The protected tail is the only default exclusion for current work. Do not preserve an additional large uncompressed tail; carry its exact state and next action in the summary.
- Default append-only: leave `[bN]` blocks untouched unless the user explicitly requested consolidation.
- Preserve the exact user objective and WHY, current plan, decisions, constraints, edits, file paths, commands and results, failures, completed and pending work, and precise next action. Remove only replaceable noise.

Result handling:
- A success receipt means the state was durably saved and the fold is already active. Make no more compression calls this turn; immediately continue the original task from the protected active tail without stopping for a compression report.
- A failure means nothing was compressed. Read the exact diagnostic, do not guess a smaller or differently formatted range, and call `compress_map` again only when instructed before retrying with labels from its returned snapshot.
</system-reminder>
