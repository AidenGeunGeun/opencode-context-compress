Use this tool during a user-initiated `/compress manage` turn to fold the completed working context into a single stored summary block. This call is the finishing step of the turn: once it returns successfully, the fold is already in effect and the older context and management scaffolding are gone from the next turn.

One new block per turn. Append it as the newest `[bN]`; never touch existing blocks.

Args:
`from`: Start entry from the `<compress-context-map>` snapshot provided with `/compress manage` (or from a fallback `compress_map` call). Use a numeric index or a grouped numeric label like `"2-4"`, or an existing `[bN]` label.
`to`: End entry from that same snapshot. Inclusive.
`summary`: The summary that replaces the selected span. Capture the WHY plus any load-bearing details — decisions, constraints, gotchas, working commands, key paths — and drop only noise. Detail is cheap; when in doubt, keep more.
`topic`: Short display label for the new block.

- The range covers only new, uncompressed entries — the completed work that piled up since the last block (or, on the first compression, all completed conversation before the active tail). Compress the oldest uncompressed content first.
- Produce exactly ONE new block this turn. Don't split the range across multiple calls.
- By default, never include or rewrite an existing `[bN]` block — older blocks stay immutable and keep their cache warm.
- Exception — ONLY when the user explicitly asks you to consolidate/compress older blocks: you may select a contiguous run of existing `[bN]` blocks and condense them into one. This deliberately invalidates cache from that point, so never do it on a normal turn.
- Leave the active tail alone — the work you're still in the middle of.
- Why append-only by default: each older block stays byte-identical across turns, so its cached tokens survive. Reaching back to rewrite a block invalidates everything after that point.
- On success, the return value is a short receipt confirming what was stored, not a map. There is nothing further to call or check this turn.
- Do not use outside explicit user-requested context management.
