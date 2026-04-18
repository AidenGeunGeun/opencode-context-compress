# Agentic Compression Workflow

## Background

Today `/compress manage` injects a large system-reminder block plus the full `<compress-context-map>` as chat text and instructs the model to call `compress` exactly once with every range batched into a single `ranges` array. The prompt dials density very high ("EXHAUSTIVE", "authoritative record so faithful that the original conversation adds no value"), which produces long summaries and inflates management-turn cost. The one-call constraint exists only because the injected map is a static snapshot — after one `compress` call, indexes would go stale.

The plugin's compression data model and transform pipeline already support everything we need for a cleaner workflow:

- `applyCompressTransforms` injects each block's full stored summary as a synthetic user message into the message stream on every turn, so the agent reads block content naturally as conversation history.
- `compressed.toolIds` + `stripToolOutputs` already know how to strip bulky tool outputs from prior turns so they do not persist.
- `CompressSummary` already carries `topic`, `anchorMessageId`, `messageIds`, and `summary`, and the `compress` tool already resolves `bN` references cleanly via `resolveContextMapRange`.

## Intent

Convert `/compress manage` from "inject a wall of instructions + map, model makes one big call" into "inject a lean reminder, agent iterates using tools, produces topical blocks with a density gradient." The user surface does not change — `/compress manage` is still the only command the user runs for compression. The agent gains the tools and the freedom to iterate within that single turn.

## Why

1. The current injection is visually ugly, token-heavy, and over-prescriptive — it hard-codes exhaustive density, hard-codes a 4-message active tail, and forbids iteration.
2. The agent cannot act in stages (scan → compress → re-check → compress older stuff more aggressively) because the injected map becomes stale after one `compress` call and there is no way to refresh it.
3. Older blocks and recent blocks warrant different fidelity. The current prompt treats them identically, so early exploration gets the same "exhaustive" treatment as just-finished implementation work.
4. The one-shot constraint forces the model to select all ranges up front without seeing the effect of its own compressions.

## Principles (must be reflected in the final design)

- **Manual boundary is absolute.** Compression runs only inside a turn the user started with `/compress manage`. No automatic nudging, no background invocation, no cross-turn state claiming "compression is still open."
- **Single-turn, multi-tool-call.** One user-initiated turn — the agent may make as many internal tool calls as needed within that turn. After the turn ends, the management window closes.
- **Density gradient is a principle, not a knob.** Older / less-relevant blocks → terse. Recent completed work → more fidelity. Active tail → do not compress. This is conveyed in the lean injection and in tool descriptions, not via config flags or per-range density parameters.
- **Agent decides the active tail.** No hardcoded "last N messages are safe." The agent uses judgment based on the conversation and the user's current focus.
- **Lean injection, rich tool descriptions.** The `/compress manage` injection is ~10 lines. The agent learns *how* to compress from the tool descriptions it reads when it calls the tools, not from a bloated system-reminder.
- **No redundant inspect path.** Block summaries already live in the agent's context as synthetic messages via `applyCompressTransforms`. Do not add a tool that re-dumps block content.
- **Management-turn tool outputs must not persist.** Every tool output produced during a `/compress manage` turn must be auto-stripped on subsequent turns via the existing `compressed.toolIds` + `stripToolOutputs` path, so the management workflow itself contributes no net context growth.

## Scope

- `lib/prompts/system.md` and `lib/prompts/compress.md` — rewrite for leaner injection and rebalanced density.
- `lib/commands/manage.ts` — adjust what gets injected when `/compress manage` fires.
- `lib/tools/` — introduce a new tool (`compress_map`) alongside the existing `compress` tool; update `compress`'s return value.
- `lib/messages/context-map.ts` — drop the hardcoded `Active: [...]` line from map output; keep index / block / token / preview info.
- `lib/tools/compress.ts` — remove the "single call per turn" narrative from both the prompt and the tool description; on successful compression, return an updated map snapshot so the agent can iterate without re-calling `compress_map`.
- `index.ts` — register the new tool, wire permission, expose via `primary_tools`.
- `lib/config.ts` + `compress.schema.json` — add config entry for `compress_map` tool permissions mirroring the `compress` tool's shape.
- Persistence / strip pipeline — ensure the new tool's `callID` is captured into `compressed.toolIds` on each invocation so its output is stripped on the next turn.
- Tests — update affected tests and add coverage for the new tool, the iterative flow, and the strip behavior.
- Prompt codegen — regenerate `_codegen/*.generated.ts` from the updated `.md` sources.
- `README.md`, `AGENTS.md`, `PROJECT_STATE.md` — update to describe the new workflow.

## Behavior

### Tool surface available to the agent during a management turn

| Tool | Purpose |
|---|---|
| `compress_map` | Returns the current compression context map as structured tool output. Agent calls this at the start of its compression work to get indexes and `bN` references, and may call it again any time it wants a fresh snapshot. |
| `compress` | Existing tool. Accepts one or more ranges, applies them, and returns an updated map representation as part of its success output so the agent can immediately continue iterating without a separate `compress_map` call. |

The agent is free to interleave these calls however it wants inside the single turn opened by `/compress manage`.

### `/compress manage` injection

- Drops the embedded `<compress-context-map>` block from the chat injection.
- Drops the multi-section "exhaustive detail" framing.
- Becomes a short system-reminder (target: ≤ ~15 lines) that conveys, in concise language:
  - Context management has been triggered by the user.
  - The agent has `compress_map` and `compress` available and should use them to produce topical blocks.
  - Density gradient principle — older / less-relevant work should be terse, recent completed work more detailed, active work not touched.
  - The agent decides what counts as "active tail."
  - Rule: do not re-wrap good blocks into mega-blocks; create new topical blocks alongside existing ones.
  - Rule: do not call `compress_map` or `compress` outside a `/compress manage` window.

### `compress_map` tool

- Returns the same structural information today's `buildContextMap` produces (numeric entries, `bN` entries, previews, per-entry token estimates, totals), minus the hardcoded `Active: [...]` line.
- Output format is compact and scannable — structured text suitable for a tool output panel, not chat prose.
- Its own `callID` is added to `state.compressed.toolIds` before returning, so on the next turn `stripToolOutputs` replaces its output with the standard placeholder. The current-turn output is intact for the model; subsequent turns see the placeholder only.

### `compress` tool changes

- Remove the "MUST submit all ranges in a single call" language from both the tool description and the system-reminder.
- Success return value includes a fresh structured map snapshot (same format `compress_map` returns) plus a concise confirmation line. This makes iteration efficient — the agent compresses, reads the updated indexes directly from the tool result, and continues.
- Its `callID` is added to `state.compressed.toolIds` so its output is stripped on subsequent turns, same mechanism as `compress_map`.
- Per-range `topic` and `summary` args stay as they are. No density parameter is added — density is governed by the gradient principle in the injection and tool description.

### Context map changes

- Remove the `Active: [...]` line from `buildMapText` output. The `ACTIVE_TAIL_COUNT` constant and any references that only exist to produce that line become dead code and must be removed.
- The `Total: N messages + M blocks | ~T tokens` footer stays.
- No other structural changes to map entries.

### Prompt rebalance

- `lib/prompts/system.md` — rewrite to be lean, density-graded, and iteration-aware. Drop "EXHAUSTIVE", drop "authoritative record so faithful the original adds no value", drop the duplicated block-preservation lectures. Keep: trigger acknowledgment, tool availability, density gradient, topical stacking rule, manual-only boundary.
- `lib/prompts/compress.md` (the tool description) — rewrite to describe mechanics (what `ranges` means, how `topic` and `summary` are used, how existing `bN` blocks behave when included in a range) and the density gradient. Remove the overlap with `system.md`. This file is what the agent reads when deciding how to use the tool, so it carries the mechanical detail that used to live in `system.md`.
- A new prompt source — e.g. `lib/prompts/compress-map.md` — defines the `compress_map` tool description. Brief, mechanical.
- Regenerate `_codegen` outputs after editing the `.md` sources.

### Lifecycle and boundaries

- Both `compress_map` and `compress` remain gated by `config.tools.*.permission !== "deny"` and stay under the same permission-ask flow as today. No runtime "is a manage window open" guard is added; the manual boundary is communicated to the model via prompt language, same pattern the plugin already relies on.
- Compression is strictly a PM-level workflow. Subagents (Orchestrator, Investigator, Auditor, Web-Search, Docs, Compaction) never run compression. This is already enforced by the existing `isSubAgent` early return in the transform hook, which must remain intact. All references to "the agent" in this spec mean the top-level PM agent invoking `compress_map` / `compress` during the user's `/compress manage` turn. Tool descriptions should not imply subagents are expected to call these tools.
- Existing sentinels (`__COMPRESS_MANAGE_HANDLED__`, etc.) remain unchanged.

## Acceptance Criteria

1. Running `/compress manage` in an existing session sends a system-reminder that is noticeably shorter than today (target: ≤ ~15 lines of text content, no embedded context map).
2. The agent has access to `compress_map` and `compress`. A fresh map can be obtained by calling `compress_map`, and the map contains numeric entries, `bN` entries, previews, per-entry token estimates, and a totals footer — and no `Active: [...]` line.
3. The agent can call `compress` more than once in the same turn with ranges that reference indexes from a previously returned map without errors, and the tool's success output includes an updated map snapshot.
4. After a `/compress manage` turn ends, subsequent turns show the block summaries as synthetic messages (existing behavior preserved) and show the `compress_map` / `compress` tool calls with their outputs replaced by the standard stripped placeholder.
5. Compressed blocks produced by the new workflow show a visible density gradient across a realistic multi-phase session — older topical blocks are terser than the most recent topical block. This is a qualitative check the Auditor can verify by reading produced summaries for an older vs. newer phase.
6. Calling `compress_map` or `compress` outside a `/compress manage` turn is still mechanically allowed (no new runtime guard), but the system-reminder and tool descriptions make clear they are for user-initiated context management only. No behavior change there.
7. `/compress stats`, `/compress context`, `/compress help` continue to work unchanged.
8. Existing tests pass. New tests cover: (a) `compress_map` output shape, (b) iterative `compress` calls within one turn, (c) `compress_map` / `compress` outputs being stripped on subsequent turns via the existing `compressed.toolIds` path, (d) removal of the `Active: [...]` line, (e) prompt codegen output reflects the rewritten sources.
9. Docs reflect the new model: `README.md` describes the agentic workflow and the two agent-facing tools; `AGENTS.md` describes the lifecycle; `PROJECT_STATE.md` key modules list includes `compress_map`.

## Verification

- `npm run generate:prompts` regenerates codegen outputs cleanly.
- `npx tsc --noEmit` passes.
- `npm test` passes.
- Manual smoke: in an OCO session with several phases of real work, run `/compress manage`, observe the lean injection, observe the agent calling `compress_map` → `compress` → optionally `compress` again in a single turn, observe the next turn's context shows synthetic summaries with no fat management payload and with the management-turn tool outputs stripped.
- Manual density check: after compression, inspect two blocks from an older vs. newer phase and confirm the older block's stored summary is meaningfully terser.

## Completion Standard

- Lean injection live; embedded map gone from the chat turn.
- `compress_map` tool implemented, registered, permission-gated, auto-stripped on subsequent turns.
- `compress` returns an updated map on success and no longer forbids multi-call iteration in either its description or the injection.
- Context map no longer emits `Active: [...]`.
- Prompts rewritten with density gradient principle and topical stacking, codegen regenerated.
- Tests pass; new coverage in place for the items in Acceptance Criteria §8.
- Docs updated.
- Build (`npm run build`) produces a working `dist/` reflecting the new surface.
