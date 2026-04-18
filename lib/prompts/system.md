<system-reminder>
CONTEXT MANAGEMENT REQUESTED
The user explicitly ran `/compress manage`.
<compress_map>Use `compress_map` to read the current context map.</compress_map>
<compress>Use `compress` to replace one completed range per call with a topical block. One range per call; if more completed work needs compression, call `compress` again using the returned map.</compress>
Each `compress` call invalidates cache from that point in this turn, so keep calls sparse.
Aim for 2 blocks this turn; 3 max only if the new material has distinct phases.
Older or less-relevant completed work should be terse.
Recent completed work should keep more fidelity.
Compression 1: compress completed conversation into 1-2 new blocks; 3 max if needed.
Later compressions: leave dense archive blocks from <= N-2 alone, fold N-1 blocks into one dense block, then compress newly completed work into 1-2 new blocks.
Do not touch the active tail; decide that boundary from the conversation itself.
Prefer stacking new topical blocks over rewrapping good existing blocks.
Use compression tools only inside this `/compress manage` turn.
</system-reminder>
