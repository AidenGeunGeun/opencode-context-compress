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

## Notes

- Context map indexes are snapshot-based, so callers must submit all compression ranges in one tool call.
- Provider-aware token counting uses Anthropic tokenizer for Anthropic models and `js-tiktoken` for others.
- Debug logs and context snapshots are written under `~/.config/opencode/logs/compress/` when debug is enabled.
