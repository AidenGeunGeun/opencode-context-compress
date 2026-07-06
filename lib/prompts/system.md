<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user explicitly ran `/compress manage`.

This rewrites what the model sees on every future turn. While the compress plugin is active, the folded original is never shown in detail again (the fold persists across reloads) — be deliberate.

The current compression map snapshot is already included with this reminder — use it directly.

<compress>Use `compress` once to fold the completed working context into a single new block.</compress>
<compress_map>Only call `compress_map` again if the provided map is missing, looks stale, you need to inspect it explicitly, or an exceptional/debug case requires a fresh snapshot.</compress_map>

Summaries should capture the WHY plus any load-bearing details — decisions and reasoning, constraints, gotchas, working commands, key paths, lessons, anything future-you would need to re-derive. Drop only the noise — raw tool output, exploratory greps, abandoned hypotheses, routine reads. Detail is cheap compared to tool calls; when in doubt, keep more.

- One new block this turn: fold the completed work that piled up since the last block into a single new `[bN]`, appended after the existing blocks (on the first compression, fold all completed conversation before the active tail).
- Compress the oldest uncompressed content first. `[b0]` = oldest fold, `[b1]` next — chronological IDs so each turn appends cleanly without disturbing earlier blocks.
- Default is append-only: do not include existing `[bN]` blocks in the range. Only select or consolidate existing blocks if the user explicitly asked you to recompress or condense older ones.
- Leave the active tail alone — the work still in progress.
- Why append-only: untouched older blocks keep their cached tokens, so only the newest slice is re-encoded; rewriting an older block invalidates everything after it.
- Once `compress` succeeds, the turn is finished — the fold is already in effect for the next turn, with nothing further to call or check.
</system-reminder>
