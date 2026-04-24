<div align="center">

<img src=".github/assets/hero.jpg" alt="opencode-context-compress hero" width="100%">

# opencode-context-compress

**Manual-first context compression. You own the when.**

[![npm version](https://img.shields.io/npm/v/%40skybluejacket%2Fopencode-context-compress?color=369eff&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@skybluejacket/opencode-context-compress)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

</div>

OpenCode plugin for explicit, user-triggered context compression.
It helps the model fold completed conversation phases into durable technical summaries only when you ask for it.

## Core Behavior

- No autonomous context management loops.
- No automatic nudges or per-turn injections.
- Compression runs only when you trigger `/compress manage`.
- During `/compress manage`, the agent can use `compress_map` and `compress` (subject to permissions).

## Commands

- `/compress` or `/compress help`: show command help.
- `/compress manage`: send a lean context-management reminder to the active agent.
- `/compress context`: show token usage breakdown for the current session.
- `/compress stats`: show session and all-time compression totals.

`/compress manage` is the only command that intentionally creates a model-visible turn.

## Agentic Workflow

When `/compress manage` runs, the plugin opens a single model-visible management turn with a short reminder. Inside that turn the agent can:

1. Call `compress_map` to fetch the current `<compress-context-map>` snapshot.
2. Call `compress` with one range at a time to replace completed phases with topical blocks.
3. Read the refreshed map returned by `compress` and continue iterating in the same turn if needed.

The manual boundary stays absolute: outside a user-triggered `/compress manage` turn, the plugin does not prompt for compression or open any background workflow.

## Context Map

`compress_map` and `compress` both use the same structured map format:

```text
<compress-context-map>
[1] user: "Let's implement JWT auth"
[2-4] assistant: 5 tool calls - auth exploration (~1,240 tokens)
[b0] [compressed] "Prior database migration debugging" (~420 tokens)
[5] user: "Looks good, now add tests"
[6-8] assistant: 4 tool calls - test implementation (~2,180 tokens)
---
Total: 8 messages + 1 block | ~6,500 tokens
</compress-context-map>
```

The agent decides what counts as the active tail. Older completed work should be compressed more tersely than the most recent completed phase. Block labels follow where their anchors appear in the conversation stream, so re-compressing one block does not renumber unrelated blocks.

## Installation

### npm (Recommended)

```bash
npm install @skybluejacket/opencode-context-compress
```

Then add it to your config:

| Platform | Global | Project-level |
| --- | --- | --- |
| OpenCode | `~/.config/opencode/opencode.jsonc` | `.opencode/opencode.jsonc` |
| [OpenCodeOrchestra](https://github.com/AidenGeunGeun/OpenCodeOrchestra) | `~/.config/oco/oco.jsonc` | `oco.jsonc` or `.oco/oco.jsonc` |

```jsonc
{
    "plugin": ["@skybluejacket/opencode-context-compress"]
}
```

### From Source

Clone the repo, build, and reference the compiled entry file directly:

```bash
git clone https://github.com/AidenGeunGeun/opencode-context-compress.git
cd opencode-context-compress
npm install
npm run build
```

```jsonc
{
    "plugin": ["file:///absolute/path/to/opencode-context-compress/dist/index.js"]
}
```

## Configuration

Config files are loaded and merged in this order:

1. `~/.config/opencode/compress.jsonc` (or `compress.json`)
2. `$OPENCODE_CONFIG_DIR/compress.jsonc` (or `compress.json`)
3. `<project>/.opencode/compress.jsonc` (or `compress.json`)

If no global config exists, the plugin creates `~/.config/opencode/compress.jsonc` with:

```jsonc
{
    "$schema": "compress.schema.json"
}
```

Default runtime config:

```jsonc
{
    "enabled": true,
    "debug": false,
    "notification": "detailed",
    "notificationType": "chat",
    "commands": {
        "enabled": true,
        "protectedTools": ["task", "todowrite", "todoread", "compress", "compress_map", "batch", "plan_enter", "plan_exit"]
    },
    "turnProtection": {
        "enabled": false,
        "turns": 4
    },
    "protectedFilePatterns": [],
    "tools": {
        "settings": {
            "protectedTools": ["task", "todowrite", "todoread", "compress", "compress_map", "batch", "plan_enter", "plan_exit"]
        },
        "compress": {
            "permission": "allow",
            "showCompression": false
        },
        "compress_map": {
            "permission": "allow"
        }
    }
}
```

## Persistence

Session state is stored at:

- `~/.local/share/opencode/storage/plugin/compress/<sessionId>.json`

Stored fields include:

- compressed tool IDs
- compressed message IDs
- compression summaries
- per-session compression stats

Management-turn outputs from `compress_map` and `compress` are left alone. They stay in conversation history like normal tool outputs unless you later compress a range that covers them.

## Development

```bash
npm install
npm run generate:prompts
npx tsc --noEmit
npm test
```

Prompt utility docs are in `scripts/README.md`.

## License

MIT
