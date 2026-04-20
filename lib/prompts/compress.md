Use this tool during a user-initiated `/compress manage` turn to replace completed conversation ranges with stored summaries.

One range per call.

Args:
`from`: Start entry from the latest `<compress-context-map>` or returned map snapshot. Accepts numeric indexes, grouped numeric labels like `"2-4"`, or block ids like `"b1"`.
`to`: End entry from the latest `<compress-context-map>` or returned map snapshot. Inclusive.
`summary`: Replacement summary for the NEW material in that selected span.
`topic`: Short display label for the resulting block.

- A range covers whole map entries from `from` through `to`.
- Existing `[bN]` blocks in the range are already preserved — write `summary` only for what you're adding or condensing now.
- Stack new topical blocks; reuse an existing `[bN]` only when it's outdated or needs to merge with adjacent same-topic work.
- Don't merge unrelated phases just because they're nearby.
- Turn budget: 2 blocks, 3 max.
- No `[bN]` blocks yet → compress completed conversation into 1-2 new blocks.
- `[bN]` blocks exist → leave older ones alone, fold the newest narrow blocks into one, then compress the rest into 1-2 new blocks.
- Older or less-relevant completed work should be terse.
- Recent completed work should keep more fidelity.
- Leave the active tail alone.
- Each call invalidates cache from that point — use as few calls as possible.
- After each call, use the fresh `<compress-context-map>` returned by the tool for the next decision.
- Do not use outside explicit user-requested context management.
