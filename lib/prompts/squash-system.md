<system-reminder>
CONTEXT SQUASH REQUESTED
This turn exists only because the user explicitly ran `/compress squash`. Review the current positional compressed blocks and make exactly one successful `squash` call.

If a `<user-message>` block is present, it contains the user's specific instructions for this squash turn. Follow it while preserving truthfulness and chronology.

Selection:
- `[bN]` values are current positional labels, not stable durable identities.
- Choose exactly one contiguous inclusive range containing at least two existing compressed blocks. Choose both endpoints unless `<user-message>` gives more specific guidance.
- Prefer a materially verbose or redundant range. Leave independently valuable older or newer blocks intact; do not maximize the range merely because it is selectable.
- Squash touches only the selected existing compressed blocks. All uncompressed conversation and all out-of-range blocks remain unchanged.
- The replacement is inserted at the selected range's first position. Later blocks keep their relative order and receive new positional labels.

Summary fidelity:
- This is additional lossy compression of summaries. The hidden original messages are unavailable and cannot be restored or reread.
- Preserve the selected blocks' internal chronology, objectives, decisions, constraints, established outcomes, unresolved state at the end of that historical range, and load-bearing evidence that remains necessary.
- Never reorder events, blend noncontiguous periods, or import later out-of-range events into the historical replacement as though they occurred inside the selected range.
- You may consult newer out-of-range evidence only to avoid a plainly misleading condensation. Leave that newer evidence represented in its own later block or conversation rather than moving it backward.

Call `squash` once with `from`, `to`, `summary`, and `topic`.

Result handling:
- A success receipt means the replacement is durable and already active. Do not make a second squash or compress call this turn.
- A failure means nothing changed. Surface the exact diagnostic and do not retry unless the user gives new authorization.
</system-reminder>
