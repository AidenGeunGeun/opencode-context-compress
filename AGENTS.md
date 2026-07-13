# AGENTS.md - opencode-context-compress

## Overview

`opencode-context-compress` is a TypeScript OpenCode plugin for model-directed manual and automatic context compression.

Core contract:

- `/compress manage` remains the explicit manual workflow.
- Automatic compression can initiate the same one-turn workflow after completed provider usage
  reaches the configured relative or absolute threshold.
- The active agent chooses the range and writes the summary; there is no separate summarizer loop.
- Management is map-first: the reminder does not include a map. The agent must call `compress_map`,
  then `compress` against that same-turn pinned snapshot. Both tools must be available.
- The primary agent may also use the same map-first pair during normal work; normal maps exclude
  the current visible user request and subsequent in-progress activity.

## Build and Test

```bash
npm run build
npm test
node --import tsx --test tests/prompts.test.ts
```

## Architecture

```text
index.ts
  Plugin entrypoint. Loads config, initializes logger/state, wires hooks,
  conditionally registers tool surfaces, and updates OpenCode config metadata.

lib/auto-compression.ts
  Reads completed assistant usage events, resolves the relative/absolute trigger,
  deduplicates per-session starts, skips subagents, and opens an asynchronous
  automatic management turn.

lib/auto-policy.ts
  Resolves global and session-level automatic-compression policy and derives the
  fixed post-compression cooldown from persisted anchors plus the raw transcript.

lib/commands/auto.ts
  Implements session-scoped `/compress auto` status, on/off, threshold, ratio,
  and reset controls with user-only feedback and atomic persistence. on/off are
  idempotent: already-matching effective state reports source without writing.

lib/tools/compress-map.ts
  Agentic map tool for normal or managed work. Builds history before the current
  user/management boundary, reapplies automatic protected IDs when relevant,
  persists one same-turn execution skeleton, then returns map text only after
  that pin is durable.

lib/tools/compress.ts
  Compression tool implementation. Requires a matching current-turn pinned
  snapshot, validates one range against that pin (no live transcript rebuild),
  requests permission, uses pinned IDs/metrics, stores summaries, atomically
  persists state, clears the pin, and marks an active management turn completed
  when one exists. Normal-turn success stores the fold without inventing a
  management marker. Success is a tiny receipt, not a refreshed map.

lib/messages/compress-transform.ts
  Applies persisted compression decisions and completed management-turn cleanup
  to outgoing message context. `findActiveManagementTurn` identifies the
  session's still-open management turn (not yet completed by `compress`, not
  yet bounded by a later visible user message). Once a turn is completed, its
  span is hidden immediately - no next user message is required - except the
  completing `compress` tool call, which stays briefly with its literal input
  intact to preserve a protocol-valid tool-call/result pair without synthetic
  placeholder text. Also reconciles a stale same-turn map pin after restart or
  a later visible user boundary.

lib/messages/context-map.ts
  Builds <compress-context-map> with numeric entries and compressed [bN] blocks,
  creates the minimal execution skeleton, resolves map boundaries from either a
  live build or a pinned snapshot, and labels the automatic active tail.
  Excludes the entire active management span from selectable entries while that
  turn is still open.

lib/commands/manage.ts
  Starts both manual and automatic management turns: requires both compression
  tools, stages automatic protected-tail IDs when needed, clears any prior map
  pin, persists the cleanup anchor, and sends a self-contained reminder that
  requires `compress_map` then `compress` (no map text is injected).

lib/config.ts
  Config schema + layered loading/merge (global/config-dir/project), defaults,
  validation, and command/tool permission normalization.

lib/state/*
  Session state, persistence, compaction resets, and tool metadata cache.
```

## Runtime Flow

1. Startup loads config and initializes state.
2. Hooks cache model limits, observe completed assistant usage, sync tool cache, apply
   compression transforms, and route `/compress` commands.
3. During normal work the agent may call `compress_map`, then `compress`; the map excludes the
   current visible user request and in-progress activity. `/compress manage` opens a management
   turn with a self-contained reminder and no map.
   The agent must call `compress_map`, then `compress` against that same-turn pin. Both tools
   must be permitted or the command fails user-only before opening a model turn.
4. `/compress auto` reads or changes the current session's persisted auto-compression
   overrides. `on`/`off` are no-ops when the effective state already matches. Global
   `autoCompression.enabled: false` remains authoritative.
5. Automatic compression starts the same map-first workflow once usage reaches the earlier of
   the configured context-window ratio and absolute token threshold, only when both tools are
   available. Protected active-tail IDs are staged at turn start and reapplied by `compress_map`;
   the success receipt instructs task continuation.
6. Successful `compress_map` atomically replaces the session's one bounded execution skeleton
   before returning map text. `compress` resolves the range from that pin's physical IDs and
   metrics without fetching or renumbering a live transcript map.
7. On a successful `compress` call, persistence is atomic: the block, IDs, stats, completion
   marker, and cooldown anchor are stored together while the pin is cleared. The fold takes
   effect for the very next model continuation - no further visible user message is required -
   and a three-eligible-response cooldown is armed before another automatic or model-initiated
   compression may run.
8. While the management turn is still open (before `compress` succeeds), its reminder and tool
   results stay visible so the agent can work; the completing `compress` tool call itself
   remains afterward too, with its literal input intact until the turn is historical.
9. On later turns, completed management machinery is hidden; only `[bN]` blocks, normal
   inter-compress conversation, and the active tail remain model-visible. A later visible user
   message, new management turn, successful compress, or native compaction clears any leftover pin.

## Prompt Generation

- Source prompt templates: `lib/prompts/*.md`
- Generated files: `lib/prompts/_codegen/*.generated.ts`
- Regenerate with `npm run generate:prompts`

## Per-Session State Management

Plugin state MUST be per-session. `lib/state/state.ts` implements `SessionStateManager` — a `Map<string, SessionState>` keyed by session ID. All hooks and tools use `stateManager.get(sessionId)` to get the correct state.

**Why**: The transform hook fires for EVERY session on EVERY loop iteration. A single shared state object would get wiped whenever a different session's transform fires, losing compression data. The old `resetSessionState()` approach was the original bug.

Each session state tracks compressed IDs, summaries, manual/automatic management-turn cleanup
markers, at most one current-turn compression-map execution skeleton, compression stats, persisted
auto-compression overrides and cooldown anchor, subagent status, initialization, and runtime-only
threshold metadata.
The execution skeleton is tied to a management trigger or normal visible-user boundary and holds only the minimal keys,
kinds, physical message IDs, optional block anchors, protected flags, tool IDs, and approximate
metrics needed to execute the map the agent was shown. It is replaced, never appended, and cleared
on success, a new turn, a later visible user message, or compaction.
Durable fields are persisted at `~/.local/share/opencode/storage/plugin/compress/<sessionId>.json`.
The `initialized` flag prevents repeated subagent/compaction bootstrap work; persisted state is
still refreshed at synchronization boundaries so concurrent runtime paths observe durable changes.

Durable mutations for one session MUST run through `SessionStateManager.runExclusive(sessionId, ...)`.
Construct and atomically save a candidate state before committing it to memory. This prevents
concurrent commands, compression tools, event hooks, and transforms from overwriting newer state;
different sessions remain independent.

Subagent sessions are detected via `isSubAgent` and skip compression entirely (early return in transform hook).

## Command Suppression

Plugin commands must prevent OpenCode from also running the default slash-command prompt. `suppressDefaultCommandExecution(output)` clears `output.parts` in place — mutating the same array `SessionPrompt.command()` holds, since reassignment would not clear it — and sets `output.cancelled = true`. This covers current OpenCode (PR #18559+ honors `cancelled`) and stock OpenCode 1.15.x (clearing parts in place suppresses the default prompt without throwing; throwing would surface as a desktop 500).

## SDK Client Adapter

OpenCode plugin hosts still expose the v1 nested SDK client (`{ path, body }`). External callers and tests may use the v2 flat client (`{ sessionID, parts, ... }`). All session/TUI calls go through `lib/sdk/client.ts`, which detects the client generation via runtime `_client` vs `client` markers.

## Publishing & Loading

The repo's git origin is `github.com/AidenGeunGeun/opencode-context-compress`. The canonical local install loads the built plugin directly from this checkout via a `file://` path in `~/.config/opencode/opencode.jsonc`, e.g. `"file:///Users/<you>/projects/opencode-context-compress/dist/index.js"`.

**`dist/` is committed to the repo** — so a prebuilt plugin is always present (and `bun add github:...` would not run lifecycle scripts for git deps anyway). Always run `npm run build` and commit `dist/` before pushing.

For local development, switch the config to `file:///path/to/dist/index.js` for fast iteration without pushing to GitHub.

## Naming History

This plugin was originally called "DCP" (Dynamic Context Pruning). It was renamed to "compress" / "context-compress" to match the user-facing `/compress` command. The legacy `"dcp"` storage directory string in `lib/state/persistence.ts` is PRESERVED for backward-compatible migration from older installs.

## Notes

- `compress_map` and `compress` are available during normal work and manual/plugin-initiated
  management turns. Every path is map-first: `compress_map` creates the pin; `compress` executes
  that pin and does not rebuild a live numeric map. Automatic protected-tail enforcement is staged
  at turn start, reapplied on the map, and enforced from the pin.
- Both tools must be available for manual or automatic management to start. There is no injected-map
  fallback when one tool is denied.
- Completed management turns leave no model-visible machinery marker; future prompts show blocks,
  inter-compress normal conversation, and active tail.
- Manual context maps do not emit a hardcoded active footer. Automatic maps label only the
  configured recent tail as `[protected active tail]`.
- `[bN]` labels are assigned by anchor position in the conversation stream, not by insertion order in `state.compressSummaries`.
- Completed `image_generation` tool outputs are represented as short placeholders for preview/token extraction; raw persisted `state.output` stays unchanged.
- Provider-aware token counting uses Anthropic tokenizer for Anthropic models and `js-tiktoken` for others.
- Debug logs and context snapshots are written under `~/.config/opencode/logs/compress/` when debug is enabled.
- Diagnostic logs prefixed with `[DIAG:]` bypass the `enabled` check in the logger — they always write regardless of debug config. Use for temporary debugging, remove before release.
