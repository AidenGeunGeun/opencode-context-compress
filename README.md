# OpenCode Context Compress

Context management for OpenCode 2 that replaces native compaction. It keeps a long session small in
three layers, so the agent rarely has to stop and summarize, and what it keeps stays exact:

1. **Background pruning.** Before each request, outputs of tool calls older than the newest 10 steps
   become the stub `[Output pruned to save context.]`. No model call is involved. Edits, patches,
   writes, and subagent, skill, todo, and question results always stay intact. On Anthropic models
   the same outputs are cleared server-side instead, through the `anthropic-auth` plugin, because
   Anthropic drops every thinking block that follows a message changed in the request.
2. **Folds.** Near the context limit, the working agent itself writes a structured handoff into a
   compressed block `[bN]`, with no hidden summarizer. The newest steps stay verbatim.
3. **Squash.** When a fold leaves more than 7 blocks or 100,000 summary characters, the agent merges
   a range of old blocks that it chooses.

Pruning keeps the provider's prompt cache warm. Request bytes change only when a prune fires, and
prunes are batched: one fires once re-reading the stale outputs from the cache, at the model's listed
cache read price, has cost two thirds of the cache rewrite the prune causes. That rewrite covers the
whole conversation after the system prompt, except on Anthropic models, where `anthropic-auth` places a cache marker before the oldest
prunable output so the rewrite starts there. Install `anthropic-auth` alongside this plugin for
Anthropic models; without it, their prunes have no effect. When a session's next request comes more
than an hour after its last one, the cache has expired and the rewrite is paid anyway, so that request
prunes every output older than the newest ten steps. Idle sessions are never woken to do this.

A fold's handoff keeps the user's intended outcome and latest request, confirmed decisions apart from
proposals, current evidence and work state, and the references needed to continue. After a fold,
active work continues; finished work or work waiting on the user stays that way.

**Native auto-compaction must stay off.** Set `compaction.auto` to `false`. The plugin API cannot
veto native compaction, so the plugin posts a warning in the session if auto-compaction runs anyway.
Manual `/compact` is a deliberate reset: OpenCode replaces the history with its own summary, and the
plugin clears every block. To merge blocks without a reset, use `/compress squash`.

## In practice

From the maintainer's own OpenCode use, with native compaction off:

- August to October 2026: the longest session ran 25 days and 8,000+ model steps, about 2B tokens
  processed (mostly cache reads), without a single native compaction. 126 sessions were compressed
  into 411 blocks, up to 40 in one session, before squash became automatic.
- Background pruning shipped on 2026-11-01. In the first 1.5 days after it, folds fell from 3.5 to
  1.05 per 1,000 model steps (156 in 44,224 steps since 2026-10-18, against 15 in 14,249), and the
  median growing step added 1,162 tokens of context instead of 1,538. The window is short and the
  workload differed, so read this as early evidence.

## Install

Requires OpenCode 2; the plugin is built against the `2.2.5` plugin API. OpenCode 1.x needs the
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

## Configure

Pruning runs on every model while the plugin is enabled. Automatic folds and squashes are on by
default and follow `autoCompression`. Optional settings live in `compress.jsonc` under the OpenCode
config directory or in a project's `.opencode` directory:

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

`protectedTurns` is the number of newest steps a fold keeps verbatim. A fold starts at the earlier of
`contextWindowRatio` of the model's context window and `tokenThreshold`. Every setting is described in
[compress.schema.json](compress.schema.json).

Edits to `compress.jsonc` apply from the next request or `/compress` command, without a server restart.
`enabled`, `commands.enabled`, a `deny` tool permission and the logging switches still need a restart.

## Use

- `/compress manage [instruction]` asks the agent for one fold now.
- `/compress squash [instruction]` replaces one contiguous range of existing blocks.
- `/compress auto [status|on|off|threshold N|ratio N|reset]` controls this session's automatic policy.
- `/compress context`, `/compress stats`, and `/compress help` post feedback without a model call.
  OpenCode may hold that feedback in the session queue until the next delivery.
- `compress({ summary, topic })` folds all eligible uncompressed history after the newest block.
- `squash({ from, to, summary, topic })` replaces existing `[bN]` blocks only.

State is stored under `$XDG_DATA_HOME/opencode/storage/plugin/compress`, with migration from the
legacy `dcp` directory. Existing blocks, management turns, cooldowns, and session auto overrides stay
compatible. Retired Goal and persona-specific fields are ignored.

## Validate

```bash
npm run check
npm test
```

When this checkout's `dist` is loaded by a running server, use the isolated build procedure in
[AGENTS.md](AGENTS.md) instead; the normal build and test scripts replace `dist`.
