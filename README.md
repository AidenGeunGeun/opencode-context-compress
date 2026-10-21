# OpenCode Context Compress

Context compression for OpenCode 2 that replaces native compaction. The working agent folds its own
history into durable compressed blocks, with no hidden summarizer, while a configurable recent
execution tail stays verbatim.

**Native auto-compaction must stay off.** Set `compaction.auto` to `false`. The plugin API cannot
veto native compaction, so the plugin posts a warning in the session if auto-compaction runs anyway.

Manual `/compact` is a deliberate reset: OpenCode replaces the history with its own summary, and the
plugin clears every compression block. To merge blocks without a reset, use `/compress squash`.

## In practice

From the maintainer's own OpenCode use, August to October 2026, with native compaction off:

- The longest session ran 25 days and 8,000+ model turns, about 2B tokens processed (mostly
  cache reads), without a single native compaction.
- 126 sessions were compressed into 411 blocks, up to 40 in one session; `/compress squash`
  merges old blocks so long sessions stay compact.

## Install

Requires OpenCode 2; the plugin is built against the `2.0.13` plugin API. OpenCode 1.x needs the
0.5 line, pinned so it does not resolve to this release:
`"plugin": ["@skybluejacket/opencode-context-compress@0.5.0"]`.

Add the plugin and disable native compaction in `opencode.jsonc`:

```jsonc
{
  "compaction": { "auto": false },
  "plugins": [{ "package": "@skybluejacket/opencode-context-compress" }]
}
```

To run a local checkout, build it with `npm install && npm run build` and set `package` to the
checkout's absolute `dist` path.

The plugin compresses automatically only when `autoCompression.enabled` is true.

Optional plugin settings live in `compress.jsonc` under the OpenCode config directory or in a project's `.opencode` directory:

```jsonc
{
  "$schema": "https://unpkg.com/@skybluejacket/opencode-context-compress@1/compress.schema.json",
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
npm run check
npm test
```

When this checkout's `dist` is loaded by a running server, use the isolated build procedure in [AGENTS.md](AGENTS.md) instead; the normal build and test scripts replace `dist`.
