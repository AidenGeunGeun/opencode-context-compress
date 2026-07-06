# AGENTS.md - opencode-context-compress

## Overview

`opencode-context-compress` is a TypeScript OpenCode plugin for explicit, user-triggered context compression.

Core contract:

- No autonomous context-management loops.
- Compression workflow is triggered by `/compress manage`.
- During that management turn, the PM agent can use `compress_map` and `compress`.

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

lib/tools/compress-map.ts
  Returns the current `<compress-context-map>` snapshot.

lib/tools/compress.ts
  Compression tool implementation. Validates one range at a time, requests
  permission, calculates range metrics, tracks compressed IDs, stores
  summaries, atomically persists state, and marks the active management turn
  completed. Success is a tiny receipt, not a refreshed map.

lib/messages/compress-transform.ts
  Applies persisted compression decisions and completed management-turn cleanup
  to outgoing message context. `findActiveManagementTurn` identifies the
  session's still-open management turn (not yet completed by `compress`, not
  yet bounded by a later visible user message). Once a turn is completed, its
  span is hidden immediately - no next user message is required - except the
  completing `compress` tool call, which stays but with its input summary
  redacted (protocol-valid tool-call/result pair).

lib/messages/context-map.ts
  Builds <compress-context-map> with numeric entries and compressed [bN] blocks,
  and resolves map boundaries to raw message IDs. Excludes the active
  management turn's own trigger message (reminder + injected map) from
  selectable entries while that turn is still open.

lib/commands/manage.ts
  Implements /compress manage: builds the current context map from the
  pre-management conversation and sends it with the reminder in one
  model-visible management turn, so the agent normally never needs to call
  `compress_map` itself.

lib/config.ts
  Config schema + layered loading/merge (global/config-dir/project), defaults,
  validation, and command/tool permission normalization.

lib/state/*
  Session state, persistence, compaction resets, and tool metadata cache.
```

## Runtime Flow

1. Startup loads config and initializes state.
2. Hooks sync tool cache, apply compression transforms, and route `/compress` commands.
3. `/compress manage` injects a short reminder plus the current `<compress-context-map>`
   snapshot in the same turn; the agent normally calls `compress` once directly.
   `compress_map` remains available as a fallback/debug/explicit-use path.
4. On a successful `compress` call, persistence is atomic and the management turn is marked
   completed immediately - the fold takes effect for the very next model continuation, with
   no need to wait for a further visible user message.
5. While the management turn is still open (before `compress` succeeds), its own prompt/map
   and tool results stay visible so the agent can work; the completing `compress` tool call
   itself remains afterward too, but with its input summary compacted to a placeholder.
6. On later turns, completed management machinery is hidden; only `[bN]` blocks, normal
   inter-compress conversation, and the active tail remain model-visible.

## Prompt Generation

- Source prompt templates: `lib/prompts/*.md`
- Generated files: `lib/prompts/_codegen/*.generated.ts`
- Regenerate with `npm run generate:prompts`

## Per-Session State Management

Plugin state MUST be per-session. `lib/state/state.ts` implements `SessionStateManager` — a `Map<string, SessionState>` keyed by session ID. All hooks and tools use `stateManager.get(sessionId)` to get the correct state.

**Why**: The transform hook fires for EVERY session on EVERY loop iteration. A single shared state object would get wiped whenever a different session's transform fires, losing compression data. The old `resetSessionState()` approach was the original bug.

Each session state tracks: `compressedMsgIds`, `compressedToolIds`, `summaries`, completed management-turn cleanup markers, `totalTokensSaved`, `isSubAgent`, `initialized`. State is persisted to disk at `~/.local/share/opencode/storage/plugin/compress/<sessionId>.json`. The `initialized` flag prevents redundant disk loads.

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

- `compress_map` and `compress` are for explicit user-requested context management only; there is no runtime manage-window guard beyond that prompt contract.
- Completed `/compress manage` turns leave no model-visible machinery marker; future prompts show blocks, inter-compress normal conversation, and active tail.
- Context maps no longer emit a hardcoded `Active: [...]` footer. The PM agent decides what counts as the active tail.
- `[bN]` labels are assigned by anchor position in the conversation stream, not by insertion order in `state.compressSummaries`.
- Completed `image_generation` tool outputs are represented as short placeholders for preview/token extraction; raw persisted `state.output` stays unchanged.
- Provider-aware token counting uses Anthropic tokenizer for Anthropic models and `js-tiktoken` for others.
- Debug logs and context snapshots are written under `~/.config/opencode/logs/compress/` when debug is enabled.
- Diagnostic logs prefixed with `[DIAG:]` bypass the `enabled` check in the logger — they always write regardless of debug config. Use for temporary debugging, remove before release.
