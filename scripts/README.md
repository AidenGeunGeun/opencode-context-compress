# Script Utilities

This directory holds local developer utilities: prompt preview/codegen, plus optional Python helpers for inspecting OpenCode session storage.

## Prompt Preview CLI (`npm run compress`)

`scripts/print.ts` renders the current compression management system prompt for quick validation.

Run with:

```bash
npm run compress -- [flags]
```

Supported flag:

- `--system`: render the compression management prompt (`renderSystemPrompt()` from `system.md`).

Examples:

```bash
npm run compress -- --system
```

There is no preview flag for automatic or squash prompts; those are covered by `tests/prompts.test.ts` and by reading the generated files under `lib/prompts/_codegen/`.

## Prompt Codegen

`npm run generate:prompts` converts markdown prompt files in `lib/prompts/` into generated TypeScript files under `lib/prompts/_codegen/`.

Current generated prompt set (one `.generated.ts` per `lib/prompts/*.md`):

- `system.generated.ts`
- `compress.generated.ts`
- `automatic-system.generated.ts`
- `squash-system.generated.ts`
- `squash.generated.ts`

## OpenCode storage helpers (Python)

Standalone scripts that read `~/.local/share/opencode/storage` (not wired into `package.json`):

| Script | Purpose |
| --- | --- |
| `opencode-find-session` | Find session IDs by title: `opencode-find-session <search-term> [--exact] [--json] [--all]` |
| `opencode-token-stats` | Token totals across recent sessions: `opencode-token-stats [--sessions N] [--session ID] [--json]` |
| `opencode-session-timeline` | Per-step token/cache timeline for one session: `opencode-session-timeline [--session ID] [--json] [--no-color]` |
| `opencode-compress-stats` | Cache impact around compress-tool calls: `opencode-compress-stats [--sessions N] [--session ID] [--min-messages M] [--json] [--verbose]` |

Run them directly (they are executable `python3` scripts). They recognize historical tool names such as `discard` / `extract` / `consolidate` as well as current `compress` / `squash` when scanning storage.
