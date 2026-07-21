# AGENTS.md - opencode-context-compress

## Overview

`opencode-context-compress` is a TypeScript OpenCode plugin for model-directed manual and automatic context compression.

Core contract:

- `/compress manage` remains the explicit manual workflow.
- Automatic compression can initiate the same one-turn workflow after completed provider usage
  reaches the configured relative or absolute threshold.
- The active agent writes one truthful `summary` and short `topic`; there is no separate
  summarizer loop and no agent-chosen numeric range.
- One public tool: `compress({ summary, topic })`. The plugin deterministically selects all
  eligible uncompressed history after the newest existing block, excludes existing blocks, and
  preserves the newest `protectedTurns` execution steps (default `3`) on manual, automatic, and
  authorized normal paths.
- Only `compress` must be available for management or automatic starts. Availability alone does
  not authorize autonomous normal-turn use.

## Build and Test

```bash
npm run build
npm test
node --import tsx --test tests/prompts.test.ts
```

`npm test` runs `npm run build` first, then all `tests/*.test.ts` files.
`npm run typecheck` regenerates prompts and typechecks without emitting.
`npm run generate:prompts` refreshes `lib/prompts/_codegen/*.generated.ts` from `lib/prompts/*.md`.

## Architecture

```text
index.ts
  Plugin entrypoint. Loads config, initializes logger/state, wires hooks,
  conditionally registers the compress tool surface, and updates OpenCode
  config metadata (including disabling native auto-compaction when plugin
  auto-compression is enabled).

lib/auto-compression.ts
  Reads completed assistant usage events, resolves the relative/absolute trigger,
  deduplicates per-session starts, skips subagents, and opens an asynchronous
  automatic management turn. On host `ContextOverflowError` with a blocked Goal,
  stages one bounded recovery turn and persists `goalOverflowRecovery` owner state.

lib/auto-policy.ts
  Resolves global and session-level automatic-compression policy and derives the
  fixed post-compression cooldown from persisted anchors plus the raw transcript.
  Visible-user boundary detection excludes recognized Goal continuation messages.

lib/goal.ts
  Goal continuation recognition (synthetic + exact prefix + `Goal reference: goa_* <ts>`),
  `ContextOverflowError` detection, overflow recovery prompt text, and
  `recoverGoalAfterCompression` (feature-detected resume with owner CAS on `id` /
  `status` / `time.updated` only; fail-open when the host has no Goal API). No Goal
  token/elapsed metrics.

lib/commands/auto.ts
  Implements session-scoped `/compress auto` status, on/off, threshold, ratio,
  and reset controls with user-only feedback and atomic persistence. on/off are
  idempotent: already-matching effective state reports source without writing.

lib/tools/compress.ts
  Single public compression tool. Accepts non-empty `summary` and `topic` only.
  Inside `runExclusive`, fetches messages, reconciles lifecycle, resolves the
  management or owning visible-user boundary, runs deterministic span selection
  via `selectDeterministicCompressionSpan`, requests permission, and atomically
  persists the new block, IDs, stats, management completion marker when
  applicable, and cooldown anchor. Clears any stale legacy snapshot field.
  Normal-turn success stores the fold without inventing a management marker.
  Success is a tiny receipt. After success, if this turn was Goal overflow
  recovery, calls `recoverGoalAfterCompression` and annotates the receipt when
  the Goal changed or the host API is unavailable.

lib/messages/context-map.ts
  Deterministic span selection (not a model-visible map). Applies existing
  transforms, finds the newest block, takes uncompressed candidates after it,
  derives the newest `protectedTurns` execution steps (step-start counting with
  recent-message fallback), and returns selected vs protected physical IDs.
  Also used to decide whether automatic management has any selectable history.

lib/messages/compress-transform.ts
  Applies persisted compression decisions and completed management-turn cleanup
  to outgoing message context. `findActiveManagementTurn` identifies the
  session's still-open management turn (not yet completed by `compress`, not
  yet bounded by a later visible user message). Goal continuation messages do
  not count as visible-user boundaries. Once a turn is completed, its span is
  hidden immediately - no next user message is required - except the completing
  `compress` tool call, which stays briefly with its literal input intact to
  preserve a protocol-valid tool-call/result pair without synthetic placeholder
  text.

lib/messages/legacy-residue.ts
  Maintainer-facing cleanup for historical management machinery, including
  residual retired tool parts from older sessions, so completed turns stay hidden.

lib/commands/manage.ts
  Starts both manual and automatic management turns: requires the `compress`
  tool, checks that automatic history remains selectable after tail protection,
  clears any stale legacy snapshot field, persists the cleanup anchor, and sends a self-contained
  reminder that requires one `compress({ summary, topic })` call. Optional
  `goalOverflowRecovery` is staged with automatic overflow recovery turns.

lib/hooks.ts
  Transform, slash-command routing, and chat.message variant caching. Goal
  continuation messages do not bound open management turns. No queue, worker,
  or map-pin state.

lib/config.ts
  Config schema + layered loading/merge (global/config-dir/project), defaults,
  validation, and command/tool permission normalization. Top-level
  `protectedTurns` (default 3); legacy `autoCompression.protectedTurns` is a
  fallback when the top-level key is absent.

lib/sdk/client.ts
  Nested v1 / flat v2 SDK adapter for session and TUI calls, plus feature-detected
  `getSessionGoal` / `resumeSessionGoal`. Local `SessionGoalInfo` matches the reduced
  host shape (`id`, `sessionID`, `objective`, `status`, `time.created` / `time.updated`);
  overflow recovery only needs `id`, `status`, and `time.updated`. Optional owner CAS
  on resume; missing Goal methods return `undefined` without breaking compression.

lib/state/*
  Session state, persistence, compaction resets, and tool metadata cache.
  Durable optional `goalOverflowRecovery` owner payload for one-shot overflow
  recovery; cleared with other session resets. Stale `compressionMapSnapshot`
  is ignored/cleared on load/reconcile and never executed.
```

## Runtime Flow

1. Startup loads config and initializes state.
2. Hooks cache model limits, observe completed assistant usage, sync tool cache, apply
   compression transforms, and route `/compress` commands.
3. During normal work the agent may call `compress` only with explicit user authorization in
   the current message. `/compress manage` opens a management turn with a self-contained
   reminder requiring one `compress({ summary, topic })` call. The `compress` tool must be
   permitted or the command fails user-only before opening a model turn.
4. `/compress auto` reads or changes the current session's persisted auto-compression
   overrides. `on`/`off` are no-ops when the effective state already matches. Global
   `autoCompression.enabled: false` remains authoritative.
5. Automatic compression starts the same one-call workflow once usage reaches the earlier of
   the configured context-window ratio and absolute token threshold, only when `compress` is
   available. The success receipt instructs task continuation when work was still active.
   Separately, a host `ContextOverflowError` on a blocked Goal stages one recovery management
   turn with `goalOverflowRecovery` owner state.
6. Inside `compress`, selection is deterministic: boundary → newest block → all eligible
   uncompressed history after it → exclude newest `protectedTurns` execution steps → never
   touch existing blocks. No agent-chosen range, map, or pin.
7. On a successful `compress` call, persistence is atomic via `runExclusive`: the block, IDs,
   stats, completion marker, and cooldown anchor are stored together. The fold takes effect
   for the very next model continuation - no further visible user message is required - and a
   three-eligible-response cooldown is armed before another automatic or model-initiated
   compression may run. If the completed turn was Goal overflow recovery, the plugin re-reads
   the Goal and resumes only the exact blocked owner via the public Goal API when present.
8. While the management turn is still open (before `compress` succeeds), its reminder and tool
   results stay visible so the agent can work; the completing `compress` tool call itself
   remains afterward too, with its literal input intact until the turn is historical. Synthetic
   Goal continuation messages do not bound that open management turn.
9. On later turns, completed management machinery is hidden; only `[bN]` blocks, normal
   inter-compress conversation, the preserved newest execution steps, and model-visible Goal
   continuation text remain. Successful compress, a new management turn, native compaction, or
   lifecycle reconcile also clear any leftover stale snapshot field. No queue/worker/extra state.

## Prompt Generation

- Source prompt templates: `lib/prompts/*.md`
- Generated files: `lib/prompts/_codegen/*.generated.ts`
- Regenerate with `npm run generate:prompts`
- Agent-facing prompts describe only the current single-tool happy path (`summary`, `topic`,
  deterministic eligible history, protected newest execution steps). Do not reintroduce retired
  workflow terms into prompt sources.

## Per-Session State Management

Plugin state MUST be per-session. `lib/state/state.ts` implements `SessionStateManager` — a `Map<string, SessionState>` keyed by session ID. All hooks and tools use `stateManager.get(sessionId)` to get the correct state.

**Why**: The transform hook fires for EVERY session on EVERY loop iteration. A single shared state object would get wiped whenever a different session's transform fires, losing compression data. The old `resetSessionState()` approach was the original bug.

Each session state tracks compressed IDs, summaries, manual/automatic management-turn cleanup
markers, compression stats, persisted auto-compression overrides and cooldown anchor, optional
`goalOverflowRecovery` owner payload, subagent status, initialization, and runtime-only threshold
metadata. Durable fields are persisted at
`~/.local/share/opencode/storage/plugin/compress/<sessionId>.json`.
The `initialized` flag prevents repeated subagent/compaction bootstrap work; persisted state is
still refreshed at synchronization boundaries so concurrent runtime paths observe durable changes.

Durable mutations for one session MUST run through `SessionStateManager.runExclusive(sessionId, ...)`.
Construct and atomically save a candidate state before committing it to memory. This prevents
concurrent commands, compression tools, event hooks, and transforms from overwriting newer state;
different sessions remain independent.

Subagent sessions are detected via `isSubAgent` and skip compression entirely (early return in transform hook).

### Maintainer compatibility notes

- Old completed blocks, management markers, cooldown anchors, auto overrides, and Goal recovery
  state continue to load.
- Stale `compressionMapSnapshot` values must not fail session load. Ignore/clear them through the
  existing lifecycle; never execute them and do not add a replacement snapshot system.
- Historical residue cleanup may still recognize retired tool part names so old completed
  management machinery stays hidden. That is cleanup-only, not a current public workflow.

## Command Suppression

Plugin commands must prevent OpenCode from also running the default slash-command prompt. `suppressDefaultCommandExecution(output)` clears `output.parts` in place — mutating the same array `SessionPrompt.command()` holds, since reassignment would not clear it — and sets `output.cancelled = true`. This covers current OpenCode (PR #18559+ honors `cancelled`) and stock OpenCode 1.15.x (clearing parts in place suppresses the default prompt without throwing; throwing would surface as a desktop 500).

## SDK Client Adapter

OpenCode plugin hosts still expose the v1 nested SDK client (`{ path, body }`). External callers and tests may use the v2 flat client (`{ sessionID, parts, ... }`). All session/TUI calls go through `lib/sdk/client.ts`, which detects the client generation via runtime `_client` vs `client` markers.

Goal helpers `getSessionGoal` / `resumeSessionGoal` are feature-detected: missing methods return
`undefined` (recovery unavailable) without breaking ordinary compression. Resume sends optional
owner CAS `{ goalID, timeUpdated }` on `{ action: "resume", owner }`. The host Goal public shape
has no token/elapsed fields; `time.updated` is lifecycle versioning only.

## Publishing & Loading

The repo's git origin is `github.com/AidenGeunGeun/opencode-context-compress`. The canonical local install loads the built plugin directly from this checkout via a `file://` path in `~/.config/opencode/opencode.jsonc`, e.g. `"file:///Users/<you>/projects/opencode-context-compress/dist/index.js"`.

**`dist/` is committed to the repo** — so a prebuilt plugin is always present (and `bun add github:...` would not run lifecycle scripts for git deps anyway). Always run `npm run build` and commit `dist/` before pushing.

For local development, switch the config to `file:///path/to/dist/index.js` for fast iteration without pushing to GitHub.

## Naming History

This plugin was originally called "DCP" (Dynamic Context Pruning). It was renamed to "compress" / "context-compress" to match the user-facing `/compress` command. The legacy `"dcp"` storage directory string in `lib/state/persistence.ts` is PRESERVED for backward-compatible migration from older installs.

## Notes

- Only `compress` is public. Manual, automatic, and authorized normal paths use the same
  deterministic selection and the same `protectedTurns` policy.
- Management and automatic starts gate on `compress` alone.
- Completed management turns leave no model-visible machinery marker; future prompts show blocks,
  inter-compress normal conversation, and the preserved newest execution steps (Goal continuation
  text stays model-visible).
- `[bN]` labels are assigned by anchor position in the conversation stream, not by insertion order
  in `state.compressSummaries`. Existing blocks are append-only and immutable under a new fold.
- `protectedTurns` defaults to `3`. Prefer the top-level config key; `autoCompression.protectedTurns`
  remains a fallback alias when the top-level key is absent.
- Goal continuation recognition is fail-open and limited to the exact synthetic prefix +
  `Goal reference: goa_* <timestamp>` contract documented in README. Do not mark host Goal
  continuations `ignored`.
- Overflow recovery is one-shot, owner-CAS gated on Goal `id` / `status` / `time.updated`, and
  disabled cleanly when Goal APIs are absent. Do not depend on Goal metrics fields.
- Completed `image_generation` tool outputs are represented as short placeholders for preview/token extraction; raw persisted `state.output` stays unchanged.
- Provider-aware token counting uses Anthropic tokenizer for Anthropic models and `js-tiktoken` for others.
- Debug logs and context snapshots are written under `~/.config/opencode/logs/compress/` when debug is enabled.
- Diagnostic logs prefixed with `[DIAG:]` bypass the `enabled` check in the logger — they always write regardless of debug config. Use for temporary debugging, remove before release.
- Focused Goal tests: `tests/goal-compatibility.test.ts` and Goal overflow cases in
  `tests/auto-compression.test.ts`. Joint host tests live in the OpenCode fork `prompt.test.ts`
  harness.
- Do not edit live OpenCode install/config or restart hosts during plugin work unless Aiden
  explicitly asks; both PM and Orchestrator already reference this repo’s `dist/index.js`.
