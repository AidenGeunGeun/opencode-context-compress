<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user explicitly ran `/compress manage`.
<compress_map>Use `compress_map` to read the current context map.</compress_map>
<compress>Use `compress` to replace one completed range per call with a topical block. One range per call; if more completed work needs compression, call `compress` again using the returned map.</compress>
- Turn budget: 2 blocks, 3 max. Each `compress` call invalidates cache from that point.
- No `[bN]` blocks yet → compress completed conversation into 1-2 new blocks.
- `[bN]` blocks exist → leave older ones alone, fold the newest narrow blocks into one, then compress the rest into 1-2 new blocks.
- Older or less-relevant completed work should be terse.
- Recent completed work should keep more fidelity.
- Leave the active tail alone.
- Stack new topical blocks; don't rewrap good existing ones.
- Use compression tools only inside this `/compress manage` turn.
</system-reminder>
