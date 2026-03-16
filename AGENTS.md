# AGENTS.md - opencode-context-compress

## Overview

`opencode-context-compress` is a TypeScript OpenCode plugin for explicit, user-triggered context compression.

Core contract:

- No autonomous context-management loops.
- Compression workflow is triggered by `/compress manage`.
- `compress` is the only model-callable tool.

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

lib/tools/compress.ts
  Compression tool implementation. Validates args, requests permission,
  calculates per-range metrics, tracks compressed IDs, and stores summaries.

lib/messages/compress-transform.ts
  Applies persisted compression decisions to outgoing message context.

lib/messages/context-map.ts
  Builds <compress-context-map> with numeric entries and compressed [bN] blocks,
  and resolves map boundaries to raw message IDs.

lib/commands/manage.ts
  Implements /compress manage: renders guidance + context map and sends one
  model-visible management turn.

lib/config.ts
  Config schema + layered loading/merge (global/config-dir/project), defaults,
  validation, and command/tool permission normalization.

lib/state/*
  Session state, persistence, compaction resets, and tool metadata cache.
```

## Runtime Flow

1. Startup loads config and initializes state.
2. Hooks sync tool cache, apply compression transforms, and route `/compress` commands.
3. `/compress manage` injects guidance and `<compress-context-map>`.
4. `compress` updates compressed IDs, summaries, and saved-token counters.

## Prompt Generation

- Source prompt templates: `lib/prompts/*.md`
- Generated files: `lib/prompts/_codegen/*.generated.ts`
- Regenerate with `npm run generate:prompts`

## Per-Session State Management

Plugin state MUST be per-session. `lib/state/state.ts` implements `SessionStateManager` — a `Map<string, SessionState>` keyed by session ID. All hooks and tools use `stateManager.get(sessionId)` to get the correct state.

**Why**: The transform hook fires for EVERY session on EVERY loop iteration. A single shared state object would get wiped whenever a different session's transform fires, losing compression data. The old `resetSessionState()` approach was the original bug.

Each session state tracks: `compressedMsgIds`, `compressedToolIds`, `summaries`, `totalTokensSaved`, `isSubAgent`, `initialized`. State is persisted to disk at `~/.local/share/opencode/storage/plugin/compress/<sessionId>.json`. The `initialized` flag prevents redundant disk loads.

Subagent sessions are detected via `isSubAgent` and skip compression entirely (early return in transform hook).

## Command Sentinel Pattern

Plugin commands throw sentinel errors to prevent default prompt flow:

```typescript
throw new Error("__COMPRESS_MANAGE_HANDLED__")
```

The OCO server catches errors ending with `_HANDLED__` in `SessionPrompt.command()` and returns `undefined` → HTTP 204. The Desktop client must call `sync.session.sync(sessionId, { force: true })` after receiving 204 to pick up server-side messages.

**All four sentinels**: `__COMPRESS_CONTEXT_HANDLED__`, `__COMPRESS_STATS_HANDLED__`, `__COMPRESS_MANAGE_HANDLED__`, `__COMPRESS_HELP_HANDLED__`.

## Publishing & GitHub Loading

The plugin is published at `github:AidenGeunGeun/opencode-context-compress`. Config reference: `"github:AidenGeunGeun/opencode-context-compress"` in `~/.config/opencode/opencode.jsonc`.

**`dist/` is committed to the repo** — required because `bun add github:...` does NOT run lifecycle scripts (prepare/postinstall) for git dependencies. Always run `npm run build` and commit `dist/` before pushing.

For local development, switch the config to `file:///path/to/dist/index.js` for fast iteration without pushing to GitHub.

## Naming History

This plugin was originally called "DCP" (Dynamic Context Pruning). It was renamed to "compress" / "context-compress" to match the user-facing `/compress` command. The legacy `"dcp"` storage directory string in `lib/state/persistence.ts` is PRESERVED for backward-compatible migration from older installs.

## Notes

- Context map indexes are snapshot-based, so callers must submit all compression ranges in one tool call.
- Provider-aware token counting uses Anthropic tokenizer for Anthropic models and `js-tiktoken` for others.
- Debug logs and context snapshots are written under `~/.config/opencode/logs/compress/` when debug is enabled.
- Diagnostic logs prefixed with `[DIAG:]` bypass the `enabled` check in the logger — they always write regardless of debug config. Use for temporary debugging, remove before release.
