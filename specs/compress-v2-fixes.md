# compress v2 fixes — single-range, stable blocks, no management-output strip

## Background

Commit `af68db2` landed the agentic `/compress manage` workflow: a lean system reminder, a new `compress_map` tool, and a `compress` tool that accepts a `ranges` array and returns a refreshed map on success. Smoke testing revealed the `compress_map` output was being stripped on the same turn it was produced — the agent saw `[Output removed to save context...]` and couldn't select ranges. A follow-up investigation identified additional real bugs in how existing `[bN]` blocks get re-compressed:

- Overlapping ranges in one `compress` call leave duplicate summaries covering the same raw messages.
- Later ranges in one `compress` call operate on a map snapshot taken before earlier ranges in the same call ran.
- Block numbering (`b0`, `b1`, `b2`, ...) comes from array position in `state.compressSummaries`; re-compressing a middle block filters it out and appends the new summary, which renumbers the surrounding blocks in a surprising way.
- Summary cleanup (`removeSubsumedCompressSummaries`) checks only the old block's `anchorMessageId`, not its full `messageIds`, so old summaries can survive when they should be dropped.

Separately, the auto-strip of `compress_map` and `compress` outputs was a design mistake that reintroduces exactly the cache-invalidation pattern the manual `/compress manage` workflow was created to avoid. Every management turn that auto-strips its own tool outputs rewrites tokens earlier in the stream on the next turn, breaking prompt caching from that point.

## Intent

Bring the second-pass workflow to the bar the user actually wanted: agentic compression inside a single `/compress manage` turn, with no cache invalidation outside the compression operation itself, and with block-recompression semantics that produce predictable, non-conflicting topical blocks.

## Principles (must be reflected in the final design)

- **Manual boundary is absolute.** No autonomous history rewrites. Core compression path changes message history exactly once per `/compress manage` invocation — never on any other turn.
- **Management-turn tool outputs do not strip.** `compress_map` and `compress` tool outputs live in context as normal tool outputs. No auto-strip, no callID registration into `state.compressed.toolIds` for these tools. The core compression strip (messages inside a compressed range) is untouched.
- **One range per `compress` call.** The `ranges` array is removed. Each `compress` call takes a single `{from, to, summary, topic}`. Atomicity was never guaranteed anyway; iteration is strictly safer and matches the one-map-per-decision protocol the user wants.
- **`compress` always returns the fresh map in its response.** Same format `compress_map` returns. The agent reads the fresh map from the response and uses it for the next decision. `compress_map` is used to open the turn (or re-check); between consecutive `compress` calls the returned map is the source of truth.
- **Block numbers are stable across re-compression of other blocks.** Creating, removing, or re-summarizing one block does not renumber unrelated blocks. Ordering follows where blocks appear in the conversation stream, not insertion order into an array.
- **Cleanup is by coverage, not by anchor alone.** If a new range's covered raw messages include any of an old summary's `messageIds`, that old summary is subsumed and removed.
- **Context map stays concise.** Small, targeted trim. Do not rewrite the format.
- **Compression is PM-only.** Subagents bypass compression entirely via the existing `isSubAgent` early return — keep intact.

## Scope

- `lib/tools/compress.ts` — collapse API to single-range; remove the callID-into-`compressed.toolIds` registration; fix summary-cleanup to use `messageIds`; ensure `anchorMessageId` selection continues to pick the first covered block's existing anchor (or the first raw message when range starts on a raw message); continue returning the refreshed map on success.
- `lib/tools/compress-map.ts` — remove the callID-into-`compressed.toolIds` registration. Do not touch the output shape.
- `lib/tools/utils.ts` — remove the helper(s) that add management tool callIDs to the strip set, and the management-tool-output filtering that was there to keep iterative maps clean. The filtering is unnecessary once outputs are no longer stripped.
- `index.ts` — remove any `tool.execute.before` hook path that feeds management tool callIDs into `state.compressed.toolIds`.
- `lib/messages/context-map.ts` — change `bN` numbering to anchor-position order (Option A from the investigator report). `state.compressSummaries` array order does not have to change; the context map computes `bN` labels from each summary's anchor's stream position at render time. Trim the format: drop the `(toolType, toolType)` list from grouped assistant entries; keep the tool-call count. Keep indexes, block refs, previews, per-entry token estimates, totals footer, and opening/closing tags exactly as-is.
- `lib/tools/compress.ts` preserved-summary lookup — today it decodes `bN` via `baselineSummaries[Number(blockId.slice(1))]`, which assumes array-index numbering. With stable numbering, the context map entry must carry a direct reference (anchor ID or the summary itself) so the tool can resolve a block reference without re-deriving array indexes.
- `lib/prompts/compress.md` — rewrite to describe single-range semantics. Drop the "submit all ranges in one call" language. Tighten the density-gradient wording to stay lean.
- `lib/prompts/compress-map.md` — minor updates if the format trim changes what the agent sees.
- `lib/prompts/system.md` — adjust workflow wording if it references multi-range.
- Regenerate `_codegen/*.generated.ts` via `npm run generate:prompts`.
- Tests — update exact-text assertions affected by the format trim; add the recompression coverage the investigator identified as missing; update the tool schema tests to the single-range shape.
- `README.md`, `AGENTS.md`, `PROJECT_STATE.md` — describe the single-range iteration, stable block numbering, and no-strip behavior.
- Rebuild `dist/`.

## Behavior

### `compress` tool — new API

- Args: `from: number | string`, `to: number | string`, `summary: string`, `topic: string`. No `ranges` array, no outer wrapper.
- Returns on success: a short confirmation line plus the refreshed `<compress-context-map>` snapshot (same format `compress_map` returns). Wording of the confirmation line is the implementer's choice within the spec's "concise output" principle.
- Does NOT register its callID into `state.compressed.toolIds`. Its output is not stripped on subsequent turns.
- Continues to: ensure session initialized; fetch messages; build map; resolve range; compute metrics; pick final summary via `selectFinalSummary`; update `state.compressed.messageIds` and `.toolIds` with raw-message content inside the range (core compression strip — unchanged); remove subsumed old summaries; push new summary; persist; send user notification if configured; return refreshed map.

### `compress_map` tool — unchanged output, no strip

- Same output it produces today.
- Does NOT register its callID into `state.compressed.toolIds`.
- Its output is not stripped on subsequent turns.

### Summary cleanup — by coverage

- `removeSubsumedCompressSummaries(summaries, containedMessageIds)` — keep the function, change the predicate. An old summary is subsumed if `summary.messageIds` has any intersection with `containedMessageIds`, OR if its `anchorMessageId` is in `containedMessageIds`. Both conditions drop it. This catches the overlap cases the anchor-only check misses.
- `containedMessageIds` passed in continues to be the full resolved `messageIds` (blocks + raw messages) from `resolveContextMapRange`.

### Block numbering — anchor-position order

- At context-map render time: compute each block's `bN` label by sorting `state.compressSummaries` by the stream position of each summary's `anchorMessageId` in the current `rawMessages`. The first block (earliest anchor) is `b0`, the next is `b1`, etc.
- `state.compressSummaries` array order does not need to be maintained. The push-at-end pattern in `compress.ts` continues to work.
- Persistence shape does not change. `CompressSummary` stays `{ anchorMessageId, messageIds, summary, topic? }`.
- If a summary's anchor is not present in `rawMessages` (post-compaction edge case), it sorts last in a stable but uninteresting way; the synthetic injection also won't fire for it. This is consistent with current behavior.

### Context map — preserve reference, trim format

- Every `ContextMapEntry` for a `block` kind already carries `rawMessageIds`. Add one field: `anchorMessageId` (or keep `rawMessageIds[0]` as the conventional anchor — whichever is cleaner). The point is: `compress.ts` must be able to resolve a `bN` to its underlying summary without decoding `bN` as an array index.
- Recommended approach: when a `bN` entry is resolved during compress, use the anchor to look up the summary in `baselineSummaries` by `anchorMessageId`, not by array index.
- Format trim: grouped assistant entries drop the `(readFile, grep, bash)` tool-type list; keep the count, keep the preview, keep the token estimate. User entries, block entries, indexes, block refs, footer, and tags stay as-is.

### Strip mechanism — unchanged for core compression

- Everything in `lib/messages/compress-transform.ts` that handles raw messages inside a compressed range stays exactly as it is. `filterCompressedRanges`, `stripCompressedTools`, `stripToolOutputs`, `stripToolInputs`, `stripToolErrors` continue to operate on tools inside compressed ranges via `state.compressed.toolIds`, which is populated by core compression in `compress.ts`.
- The change is only in who gets added to `state.compressed.toolIds`: core compression of raw messages still adds their tool callIDs; management tools (`compress`, `compress_map`) no longer do.

### Prompt updates

- `lib/prompts/compress.md`: describe single-range API. Explicitly say "one range per call; iterate by calling again." Keep density-gradient wording and topical stacking. Drop the "MUST submit all ranges in a single call" language wherever it survives.
- `lib/prompts/system.md`: adjust workflow summary if it mentions multi-range or implies stripping; otherwise keep lean.
- `lib/prompts/compress-map.md`: only update if the tool's output shape trim changes what the prompt describes.
- Regenerate codegen.

## Out of scope for this pass

- Duplicate-anchor collisions in `state.compressSummaries` (investigator's unverified risk #1). Documented as a follow-up. Manual persistence state editing is the only realistic source.
- Compaction-timing race between the tool path and the transform hook's reset (investigator's unverified risk #2). Documented as a follow-up. Would need a runtime trace to confirm reachability.
- Performance caching of per-message token counts. User vetoed caching.
- Context map format rewrite beyond the tool-type-list drop. User authorized "small, targeted" only.

## Acceptance Criteria

1. `compress` takes a single range (`from`, `to`, `summary`, `topic`) and no `ranges` array. Its tool schema reflects this.
2. `compress` returns a refreshed `<compress-context-map>` snapshot in its success response.
3. Neither `compress` nor `compress_map` adds its callID to `state.compressed.toolIds`. Their outputs persist unchanged in future turns.
4. Raw messages inside a compressed range continue to be removed from the transformed message stream on subsequent turns (existing behavior preserved via existing tests).
5. `removeSubsumedCompressSummaries` drops an old summary when its `messageIds` intersect the new range's covered IDs, not only when its anchor does.
6. `bN` labels in the context map are stable across re-compression of other blocks. A regression test creates `b0`, `b1`, `b2`, re-compresses the middle one, and asserts `b0` and `b1` labels survive unchanged (or, equivalently, that the labeling follows the stream-position ordering of anchors).
7. Grouped assistant map entries no longer include the `(toolA, toolB)` tool-type list. The tool-call count remains.
8. Prompts (`compress.md`, `compress-map.md`, `system.md`) describe single-range iteration and no longer mention multi-range or the single-call constraint. Codegen regenerated.
9. New test coverage for: (a) pure-block recompression via real `compress` tool call, (b) mixed recompression that includes both an existing `bN` and new raw messages, (c) two consecutive `compress` calls where the second references a block created by the first, (d) subsumption by overlap (anchor outside new range but messageIds intersect).
10. Existing tests pass after schema/format updates.
11. Docs (`README.md`, `AGENTS.md`, `PROJECT_STATE.md`) reflect the single-range iteration model, stable block numbering, and no-strip behavior.
12. `dist/` rebuilt and committed.

## Verification

- `npm run generate:prompts` — clean regeneration.
- `npx tsc --noEmit` — passes.
- `npm test` — passes; new tests in place per §9.
- `npm run build` — rebuilds `dist/` without error.
- Manual smoke in an OCO session: `/compress manage` fires → agent calls `compress_map` → agent calls `compress` with a single range → tool output visible (not stripped) → agent reads the refreshed map from the return value → agent calls `compress` again using the refreshed indexes → confirm `b0`-level labels stay stable where expected.
- Cache-invalidation check (manual): between two consecutive turns where the prior turn was a `/compress manage`, the prefix of the message stream up to the compressed synthetic summaries should be byte-stable (no prior tool outputs swapped for placeholders). This is the practical cache-stability guarantee.

## Completion Standard

- Single-range `compress` implemented and documented.
- No management-tool auto-strip; callID-registration paths for `compress` / `compress_map` removed from tool-side code and from any `tool.execute.before` hook.
- Summary cleanup uses `messageIds` intersection.
- `bN` numbering stable via anchor-position ordering at render time; `compress.ts` resolves `bN` entries via anchor lookup, not array index.
- Map format trimmed per scope (tool-type list gone).
- Prompts updated and codegen regenerated.
- New regression tests cover the four scenarios in §9.
- Docs updated.
- `dist/` rebuilt.
