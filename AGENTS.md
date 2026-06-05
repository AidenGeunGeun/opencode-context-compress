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
  summaries, and returns a refreshed map snapshot for iterative use.

lib/messages/compress-transform.ts
  Applies persisted compression decisions and completed management-turn cleanup
  to outgoing message context.

lib/messages/context-map.ts
  Builds <compress-context-map> with numeric entries and compressed [bN] blocks,
  and resolves map boundaries to raw message IDs.

lib/commands/manage.ts
  Implements /compress manage: renders a lean reminder and sends one
  model-visible management turn without embedding the map.

lib/config.ts
  Config schema + layered loading/merge (global/config-dir/project), defaults,
  validation, and command/tool permission normalization.

lib/state/*
  Session state, persistence, compaction resets, and tool metadata cache.
```

## Runtime Flow

1. Startup loads config and initializes state.
2. Hooks sync tool cache, apply compression transforms, and route `/compress` commands.
3. `/compress manage` injects a short reminder; the agent fetches the map with `compress_map`.
4. `compress` handles one range per call, then returns an updated map for same-turn iteration.
5. During that management turn, maps and tool results stay visible so the agent can work.
6. On later turns, completed management machinery is hidden; only `[bN]` blocks, normal inter-compress conversation, and the active tail remain model-visible.

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

Plugin commands must prevent OpenCode from also running the default slash-command prompt. The handler uses a dual strategy:

1. **Current OpenCode (upstream PR #18559+)**: set `output.cancelled = true` and clear `output.parts`.
2. **OCO / legacy hosts**: throw a sentinel error ending in `_HANDLED__`.

```typescript
suppressDefaultCommandExecution(output, "__COMPRESS_MANAGE_HANDLED__")
```

**Sentinels**: `__COMPRESS_CONTEXT_HANDLED__`, `__COMPRESS_STATS_HANDLED__`, `__COMPRESS_MANAGE_HANDLED__`, `__COMPRESS_HELP_HANDLED__`.

On OCO, `SessionPrompt.command()` catches `_HANDLED__` sentinels and returns HTTP 204. On upstream OpenCode versions with `command.execute.before` cancellation support, no throw is needed.

## SDK Client Adapter

OpenCode plugin hosts still expose the v1 nested SDK client (`{ path, body }`). External callers and tests may use the v2 flat client (`{ sessionID, parts, ... }`). All session/TUI calls go through `lib/sdk/client.ts`, which detects the client generation via runtime `_client` vs `client` markers.

## Session Fork Support

`session.fork` is an OCO extension hook. Current upstream OpenCode plugin types do not expose it, so forked sessions on stock upstream OpenCode do **not** receive migrated compression state. This is safe degradation: the fork shows the uncompressed transcript instead of silently corrupting IDs. OCO and future upstream builds that add the hook keep full fork migration via `forkSessionState()`.

## Publishing & GitHub Loading

The plugin is published at `github:AidenGeunGeun/opencode-context-compress`. Config reference: `"github:AidenGeunGeun/opencode-context-compress"` in `~/.config/opencode/opencode.jsonc`.

**`dist/` is committed to the repo** — required because `bun add github:...` does NOT run lifecycle scripts (prepare/postinstall) for git dependencies. Always run `npm run build` and commit `dist/` before pushing.

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
