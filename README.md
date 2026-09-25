# OpenCode Context Compress

Standalone context compression for the OpenCode 2.0.13 Promise plugin API. It keeps durable compressed blocks while preserving a configurable recent execution tail.

## Install

This checkout targets `2.0.13`.

```bash
npm install
npm run build
```

Point OpenCode at the built plugin directory and disable native automatic compaction in `opencode.jsonc`:

```jsonc
{
  "compaction": { "auto": false },
  "plugins": [{ "package": "/absolute/path/to/opencode-context-compress/dist" }]
}
```

The plugin owns automatic compression only when `autoCompression.enabled` is true. Native compaction must stay disabled because the 2.0.13 API has no compaction-veto hook.

Optional plugin settings live in `compress.jsonc` under the OpenCode config directory or in a project's `.opencode` directory:

```jsonc
{
  "$schema": "/absolute/path/to/opencode-context-compress/compress.schema.json",
  "protectedTurns": 3,
  "autoCompression": {
    "enabled": true,
    "contextWindowRatio": 0.9,
    "tokenThreshold": 432000
  }
}
```

## Use

- `/compress manage [instruction]` starts one deterministic compression turn.
- `/compress squash [instruction]` replaces one contiguous range of existing blocks.
- `/compress auto [status|on|off|threshold N|ratio N|reset]` controls this session's automatic policy.
- `/compress context`, `/compress stats`, and `/compress help` enqueue synthetic feedback without a model call. Feedback remains queued until a later session delivery.
- `compress({ summary, topic })` folds all eligible uncompressed history after the newest block.
- `squash({ from, to, summary, topic })` replaces existing `[bN]` blocks only.

Compression does not grant permission to edit project documentation. Read-only callers return candidate findings to their parent and continue compression without making those edits.

Compression handoffs preserve the user's intended outcome, latest request, confirmed decisions
separately from proposals, current evidence and work state, and concrete continuation references.
Documentation edits cover only changed, verified information within existing authority. After
success, active work continues; completed or awaiting-user work stays in that disposition. Reload
only task-relevant instructions whose needed contents are missing or may have changed. These prompts
are model-independent.

State is stored under `$XDG_DATA_HOME/opencode/storage/plugin/compress`, with migration from the
legacy `dcp` directory. Existing compression blocks, management turns, cooldowns, and session auto
overrides remain compatible. Retired Goal and persona-specific fields are ignored.

## Validate

```bash
npm run typecheck
npm test
```

When this checkout's `dist` is loaded by a running server, use the isolated build procedure in [AGENTS.md](AGENTS.md) instead; the normal build and test scripts replace `dist`.
