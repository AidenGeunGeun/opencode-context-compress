# Smoke Test Context Snapshot — Source of Truth

**Purpose:** Pre-compression ground-truth document. If compression loses, warps, or silently merges information, cross-reference post-compression summaries against this file to detect drift.

**Written at:** ~104K tokens into the conversation, immediately before the user triggers `/compress manage` for the first time on the new agentic compression plugin build.

**Written by:** PM (top-level agent, Claude Opus 4.7) in `/Users/aidenkim/projects/agents/OCstuff` working directory.

---

## 1. Who / Where / Setup

- User: Aiden (see `/Users/aidenkim/projects/AGENTS.md` — `/projects` is where Aiden's projects live, including aerospace engineering and agent/personal side projects).
- Working directory: `/Users/aidenkim/projects/agents/OCstuff`.
- Platform: darwin. Not a git repo at the cwd level (it's a parent folder containing multiple projects).
- Relevant project for this conversation: `/Users/aidenkim/projects/agents/OCstuff/opencode-context-compress` — the plugin under test.
- OCO config dir: `~/.config/oco/`. Key files inspected:
  - `~/.config/oco/oco.jsonc` — main OCO config; contains agent definitions, MCP servers, providers, `plugin` list.
  - `~/.config/oco/compress.jsonc` — minimal compress plugin config (enabled, permission allow, showCompression false).
  - `~/.config/oco/package.json` — declares `@opencode-ai/plugin` 1.1.4 dep.
  - `~/.config/oco/prompts/` — `auditor.txt`, `compaction.txt`, `docs.txt`, `investigator.txt`, `orchestrator.txt`, `pm.txt`, `web-search.txt`.
  - `~/.config/oco/AGENTS.md` — OpenCode setup notes (variants, `Ctrl+T` keybind, tui.json location, `openai/gpt-5.4-fast` variants configured).
- Agent lineup in `oco.jsonc`:
  - `plan` and `build` both use PM prompt, `anthropic/claude-opus-4-7`, effort xhigh.
  - `orchestrator` uses `openai/gpt-5.4-fast` xhigh.
  - `web-search`, `investigator` — gpt-5.4-fast medium.
  - `auditor` — gpt-5.4-fast high.
  - `compaction` — `openai/gpt-5.4-mini` medium.
  - `docs` — `anthropic/claude-sonnet-4-6` adaptive thinking / medium effort.
  - `general` and `explore` disabled.

## 2. The Plugin Before This Session

- Name: `opencode-context-compress`, package `@skybluejacket/opencode-context-compress`, license MIT.
- Published location: `github:AidenGeunGeun/opencode-context-compress`. `dist/` is committed (required because `bun add github:...` does NOT run lifecycle scripts for git deps).
- Historical name: originally "DCP" (Dynamic Context Pruning); `dcp` storage dir string preserved in `lib/state/persistence.ts` for backward compatibility.
- Core contract (pre-session):
  - No autonomous context management.
  - Compression only via `/compress manage`.
  - `compress` is the only model-callable tool.
  - Commands: `/compress`, `/compress help`, `/compress manage`, `/compress context`, `/compress stats`.
- Per-session state manager (`SessionStateManager`, `Map<string, SessionState>`). Subagent sessions detected via `isSubAgent` and skip compression entirely (early return in transform hook).
- Sentinel error pattern: slash commands throw e.g. `__COMPRESS_MANAGE_HANDLED__` to suppress default prompt flow. Four sentinels: CONTEXT / STATS / MANAGE / HELP.
- Transform pipeline in `lib/messages/compress-transform.ts`:
  - `applyCompressTransforms` runs on every turn: filters compressed ranges, strips compressed tool outputs, strips compressed tool inputs, strips compressed tool errors.
  - `transformMessagesForSearch` materializes each `CompressSummary.summary` as a synthetic user message in the stream. This means the agent ALREADY reads full block content as conversation history every turn.
  - `stripToolOutputs` replaces outputs of tools in `state.compressed.toolIds` with `"[Output removed to save context - information superseded or no longer needed]"`.
- `CompressSummary` schema: `anchorMessageId`, `messageIds[]`, `summary`, `topic` (topic was added in commit `7f92a04` "topical block stacking").
- `buildContextMap` in `lib/messages/context-map.ts`:
  - Produced numeric message entries and `[bN]` block entries.
  - Had a hardcoded `ACTIVE_TAIL_COUNT = 4` constant and emitted an `Active: [N-M] (current work - do not compress)` line.
  - Uses `countTokens` with provider-aware tokenizer (Anthropic tokenizer for Anthropic models, `js-tiktoken` elsewhere).
- `compress` tool (`lib/tools/compress.ts`):
  - Took `ranges: Array<{ from, to, summary, topic }>`.
  - Required all ranges in a SINGLE call — because the injected map became stale after one call.
  - Used `resolveContextMapRange` to turn indexes / `bN` refs into message IDs.
  - `selectFinalSummary` — pure-block condense uses model summary directly; mixed-block uses `composeSummaryWithPreservedBlocks` which strips recursive preservation markers.
- Old prompts (what we replaced):
  - `lib/prompts/system.md` — 54 lines, `<system-reminder>` block, told the model to compress "EXHAUSTIVE[LY]", called summaries an "AUTHORITATIVE REPLACEMENT", dense block-preservation section, forced single-call semantics.
  - `lib/prompts/compress.md` — tool description; also used "EXHAUSTIVE" / "authoritative record so faithful that the original conversation adds no value" / BLOCK LIFECYCLE stacking section.
- Old `/compress manage` behavior (`lib/commands/manage.ts`):
  - Injected the rendered system prompt + the full `<compress-context-map>` text + a "compress_manage_directive" wrapper as one giant chat text payload.
- Recent commits before this session (most recent first):
  - `a807d5b` docs: add project-level config paths for OpenCode and OCO
  - `2cfeb44` Update README.md
  - `a9f40cb` docs: add npm installation method
  - `23c076a` chore: fix metadata for npm publish (author, repo url, version 0.2.0)
  - `e0999fc` fix: pure-block condense uses model summary directly
  - `7f92a04` feat: topical block stacking over mega-compression
  - `a82aecd` chore: scope package name to @skybluejacket, update license to MIT
  - `11c8287` Fix session-scoped compress state sync
  - `bb6bbe6` chore: remove diagnostic logging
  - `8836044` docs: document per-session state, sentinel pattern, GitHub loading
  - `571aaf8` fix: per-session state isolation
  - `820d678` Initial release v0.1.0

## 3. User's Complaints and Goals This Session

- `/compress manage` injects too-tuned instructions that make the model produce overly detailed summaries, which makes extended conversations long and expensive.
- The plugin compresses earlier blocks but doesn't allow fine-grained per-block access or tuning.
- User wants to keep the manual boundary (user-initiated `/compress manage` only) — autonomous compression was rejected earlier because the model would think it needed compression, nuke important context, and inflate pricing.
- User experience should remain a single command (`/compress manage`) — the improvement happens inside the turn, not by exposing more user commands.
- Older / less-relevant blocks should compress with LOWER information density; recent blocks deserve MORE fidelity.
- System prompts and injections should be concise, not fine-tuned to the point of over-prescription. "The model has to know" rather than "the model is told exactly what to write."
- The fat injection block from `/compress manage` looks ugly.
- Idea the user floated: maybe give the agent more tools with detailed descriptions, rather than adding user commands. Context map as tool output rather than chat injection. Agent must know the context map changes after each compress call.
- Workflow should be "agentic."

## 4. The Design Conversation — Key Beats

- First pass I proposed: four buckets of improvements (prompt rebalance, density knob, per-block user commands, trim injection). User rejected the density knob and per-block user commands — user commands violate the one-command principle; density should be a PRINCIPLE not a knob.
- I proposed three agent tools: `compress_map`, `compress_inspect bN`, `compress`. User pushed back on `compress_inspect`: if the agent calls inspect, it pulls full block content (1–3K tokens) into context that then won't get compressed — because the map built before inspect doesn't know inspect ran.
- KEY REALIZATION (I missed it initially, user surfaced it): `applyCompressTransforms` already materializes each block's full stored summary as a synthetic user message on every turn. The agent ALREADY sees full block content naturally. `compress_inspect` would duplicate what's already in context. Dropped.
- Final agreed design (documented in the spec):
  - Manual boundary absolute. `/compress manage` stays the only user command.
  - Single-turn, multi-tool-call. Agent iterates within one turn.
  - Two agent tools: `compress_map` (returns live map), `compress` (acts on ranges, returns updated map on success).
  - Drop the single-call constraint on `compress`.
  - Drop the hardcoded `Active: [...]` line and `ACTIVE_TAIL_COUNT`. Agent decides active tail from density gradient principle.
  - Density gradient as PRINCIPLE baked into lean injection — no config flag, no per-range density param.
  - Management-turn tool outputs auto-stripped on next turn via existing `state.compressed.toolIds` + `stripToolOutputs` path. No new mechanism.
  - Lean injection ≤ ~15 lines of content; no embedded map. Tool descriptions carry mechanical detail. No duplication between injection and tool descriptions.
- User correction during delegation: **Orchestrators never run compression. Only PM.** This is because PM holds the long arc; Orchestrator sessions are single-task scoped. Already enforced by `isSubAgent` early return — kept intact. I added an explicit note to the spec.

## 5. The Spec

- Path: `/Users/aidenkim/projects/agents/OCstuff/opencode-context-compress/specs/agentic-compression-workflow.md`.
- Sections: Background, Intent, Why, Principles, Scope, Behavior (tool surface, injection, tool changes, context map changes, prompt rebalance, lifecycle), Acceptance Criteria (9 items), Verification, Completion Standard.
- Key acceptance items:
  1. `/compress manage` injection ≤ ~15 lines content, no embedded map.
  2. `compress_map` returns the map with indexes, `bN` entries, previews, token estimates, totals footer; NO `Active:` line.
  3. Agent can call `compress` multiple times in one turn; success includes updated map snapshot.
  4. Next-turn context shows synthetic summaries + uncompressed tail; management-turn tool outputs auto-stripped.
  5. Density gradient visible in produced summaries (older terser than recent).
  6. No new runtime guard for manage-window; boundary communicated via prompts.
  7. `/compress stats`, `/compress context`, `/compress help` unchanged.
  8. Tests: map shape, iterative compress, strip behavior, `Active:` removal, codegen sync.
  9. Docs updated (README, AGENTS.md, PROJECT_STATE.md).

## 6. The Implementation

- Delegated to Orchestrator (`openai/gpt-5.4-fast` xhigh) via `mcp_Task`.
- Orchestrator reported COMPLETED. Auditor pass: PASS, no blocking findings, no warnings.
- Tests: **69/69 passing**. `npm run generate:prompts` ✅. `npx tsc --noEmit` ✅. `npm run build` ✅.
- Files changed (from Orchestrator's report):
  - Source / registration: `index.ts`, `lib/commands/manage.ts`, `lib/config.ts`, `lib/messages/context-map.ts`, `lib/tools/compress.ts`, NEW `lib/tools/compress-map.ts`, `lib/tools/index.ts`, `lib/tools/utils.ts`.
  - Prompts: `lib/prompts/system.md`, `lib/prompts/compress.md`, NEW `lib/prompts/compress-map.md`, `lib/prompts/index.ts`, regenerated `lib/prompts/_codegen/*.generated.ts` (including new `compress-map.generated.*`).
  - Tests: updated `tests/prompts.test.ts`, `tests/context-map.test.ts`, `tests/compress-overlay-sync.test.ts`; NEW `tests/manage-command.test.ts`, NEW `tests/compress-tools.test.ts`.
  - Docs: `README.md`, `AGENTS.md`, `PROJECT_STATE.md`, `scripts/print.ts`, `scripts/README.md`.
  - Build: regenerated `dist/**`, updated `compress.schema.json`.
- Two implementation choices Orchestrator flagged as made within HOW latitude:
  1. `ToolContext` doesn't expose `callID` in its type, so used BOTH a `tool.execute.before` hook AND tool-side registration to reliably capture call IDs into `state.compressed.toolIds`. Belt-and-braces but correct.
  2. Added a guard to filter prior `compress_map` / `compress` tool chatter out of refreshed same-turn map snapshots, so iterative indexes don't drift if raw history still contains earlier management tool messages.
- `compress_map` config: permission-only entry. `compress` still has `showCompression` UI toggle.

## 7. Commit and Push

- Commit: `af68db2` on `main`.
- Title: `feat: agentic /compress manage workflow with compress_map tool`.
- Body covers: prompts, tools, context map, config, tests, docs, PM-only note.
- 67 files changed, +948 / −301.
- Push initially failed: `git@github.com: Permission denied (publickey)` — SSH key not authorized on GitHub.
- Fix: `gh auth setup-git` + switched remote from `git@github.com:AidenGeunGeun/opencode-context-compress.git` (SSH) to `https://github.com/AidenGeunGeun/opencode-context-compress.git` (HTTPS, uses gh's HTTPS token `gho_...` — account `AidenGeunGeun`, keyring-stored, scopes: gist, read:org, repo, workflow).
- Final push: `a807d5b..af68db2  main -> main`. Successful.
- **No npm release published yet.** `package.json` version untouched. No `npm publish` run.
- `specs/` stayed untracked (local planning artifact, not in `.gitignore` but explicitly not staged).

## 8. Config Change for Smoke Test

- User instructed: load the plugin from filesystem so the new local build is used.
- Edited `~/.config/oco/oco.jsonc` line 12:
  - Before: `"plugin": ["@skybluejacket/opencode-context-compress"],`
  - After: `"plugin": ["file:///Users/aidenkim/projects/agents/OCstuff/opencode-context-compress/dist/index.js"],`
- User will reboot OCO after this change. Reminder noted: flip back to npm package name once smoke test passes and we publish.

## 9. Current State — The Smoke Test

- User is about to trigger `/compress manage` for the first time on the new build.
- Context is ~104K tokens. This document itself is being written as the ground-truth artifact for post-compression comparison.
- Concerns (articulated by user, reasonable):
  - Compression could silently omit required memory.
  - Blocks in the middle could get lost.
  - Unexpected issues could arise after compressing an already-compressed block (recursive compression).
- Validation plan after compression runs:
  - Re-read this document.
  - Compare to the compressed synthetic summaries in context.
  - Check for: missing facts, merged-but-distinct topics, lost file paths / commit hashes / config values, warped decisions.
  - Verify the `Active:` line is gone from the map.
  - Verify `compress_map` ran as a tool call (not as chat injection) and its output was stripped on subsequent turns.
  - Verify density gradient — older blocks (design discussion) should be TERSER than recent blocks (implementation / commit / config change).

## 10. Things That Would Be Suspicious Post-Compression

- If the PM-only constraint disappears from any summary.
- If `isSubAgent` early return stops being mentioned.
- If the original name "DCP" is lost (persistence path backward-compat detail).
- If commit hash `af68db2` is wrong or missing.
- If the remote-URL switch detail is lost (SSH → HTTPS via `gh auth setup-git`).
- If the config file-path change (`file:///...dist/index.js`) is dropped — we need it to revert before npm publish.
- If the Orchestrator's two implementation decisions (`tool.execute.before` fallback; same-turn map-snapshot guard) disappear — these are non-obvious and worth preserving.
- If the `compress_inspect` rejection rationale is lost (subsequent confusion about "why don't we have an inspect tool?" would mean the compressed summary failed to preserve the key transform-hook insight).
- If the rejection of the density knob is lost (someone might re-propose it).
- If `ACTIVE_TAIL_COUNT` removal is described incorrectly.

## 11. Open Follow-ups

- Manual smoke test (this is it).
- Once validated: bump version in `package.json`, `npm publish`, flip `oco.jsonc` plugin entry back to `@skybluejacket/opencode-context-compress`.
- Qualitative density-gradient check from real session output (Orchestrator flagged this as not done programmatically).

---

**End of snapshot. If reading this post-compression: anything in this document that is not reflected in the compressed summaries (or is contradicted by them) is a compression fidelity issue worth surfacing to the user.**
