# opencode-context-compress

Manual-first OpenCode plugin for explicit context compression.

This plugin does one thing: it helps the model compress completed conversation phases into durable technical summaries when you explicitly ask for it.

## Core Behavior

- No autonomous context management loops.
- No automatic nudges or per-turn injections.
- Compression runs only when you trigger `/compress manage`.
- The only model-callable tool is `compress` (subject to permissions).

## Commands

- `/compress` or `/compress help`: show command help.
- `/compress manage`: send compression guidance and context map to the active agent.
- `/compress context`: show token usage breakdown for the current session.
- `/compress stats`: show session and all-time compression totals.

`/compress manage` is the only command that intentionally creates a model-visible turn.

## Context Map

When `/compress manage` runs, the plugin injects a structured map:

```text
<compress-context-map>
[1] user: "Let's implement JWT auth"
[2-4] assistant: 5 tool calls (read, glob, bash) - auth exploration (~1,240 tokens)
[b0] [compressed] "Prior database migration debugging" (~420 tokens)
[5] user: "Looks good, now add tests"
[6-8] assistant: 4 tool calls (edit, write, bash) - test implementation (~2,180 tokens)
---
Active: [5-8] (current work - do not compress)
Total: 8 messages + 1 block | ~6,500 tokens
</compress-context-map>
```

The model selects ranges by index and calls `compress` with a `ranges` array.

## Installation

Build the plugin and reference the compiled entry file in your OpenCode config:

```jsonc
{
    "plugin": ["file:///absolute/path/to/plugin/dist/index.js"]
}
```

Build command:

```bash
npm run build
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
        "protectedTools": ["task", "todowrite", "todoread", "compress", "batch", "plan_enter", "plan_exit"]
    },
    "turnProtection": {
        "enabled": false,
        "turns": 4
    },
    "protectedFilePatterns": [],
    "tools": {
        "settings": {
            "protectedTools": ["task", "todowrite", "todoread", "compress", "batch", "plan_enter", "plan_exit"]
        },
        "compress": {
            "permission": "allow",
            "showCompression": false
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
