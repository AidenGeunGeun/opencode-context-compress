# OpenCode Context Compress

Context management for OpenCode 2. It keeps a long session small in two layers, so the agent rarely
has to stop and summarize, and what it keeps stays exact:

1. **Background pruning.** Before each request, outputs of tool calls older than the newest 10 steps
   become the stub `[Output pruned to save context.]`. No model call is involved. Edits, patches,
   writes, and subagent, skill, todo, and question results always stay intact. On Anthropic models
   the same outputs are cleared server-side instead, through the `anthropic-auth` plugin, because
   Anthropic drops every thinking block that follows a message changed in the request.
2. **Folds.** At a token threshold the plugin asks the working agent to finish its step, bring the
   project's documentation up to date, and call `compress` with a summary it writes itself, with no
   hidden summarizer. The plugin hands that summary to OpenCode's compaction, which replaces the
   whole conversation with it right after the step, without a model request, and loads the
   project's instructions fresh. An ignored request repeats every further 100,000 tokens.

Pruning keeps the provider's prompt cache warm. Request bytes change only when a prune fires, and
prunes are batched: one fires once re-reading the stale outputs from the cache, at the model's listed
cache read price, has cost two thirds of the cache rewrite the prune causes. That rewrite covers the
whole conversation after the system prompt, except on Anthropic models, where `anthropic-auth` places a cache marker before the oldest
prunable output so the rewrite starts there. Install `anthropic-auth` alongside this plugin for
Anthropic models; without it, their prunes have no effect. When a session's next request comes more
than an hour after its last one, the cache has expired and the rewrite is paid anyway, so that request
prunes every output older than the newest ten steps. Idle sessions are never woken to do this.

A fold's summary keeps the user's goal and latest request, the user's decisions apart from the
agent's proposals, the work state with its evidence, the next step, and the references needed to
continue. It leaves out what the project's instructions and documentation already say. Nothing else
survives a fold, so the documentation is the long-lived memory and the summary only a note about the
work in progress. After a fold, active work continues; finished work or work waiting on the user
stays that way. A subagent skips the documentation pass, which belongs to the session that briefed
it, and puts its findings in the summary for that parent.

**Keep native auto-compaction off.** Set `compaction.auto` to `false`: it would replace the
conversation with OpenCode's own summary at a token count, without the documentation pass. A fold
runs as a manual compaction, so it works with that setting. Manual `/compact` still gives OpenCode's
own summary.

## In practice

From the maintainer's own OpenCode use:

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

Pruning runs on every model while the plugin is enabled. Automatic fold requests are on by default
and follow `autoCompression`. Optional settings live in `compress.jsonc` under the OpenCode
config directory or in a project's `.opencode` directory:

```jsonc
{
  "$schema": "https://unpkg.com/@skybluejacket/opencode-context-compress@1/compress.schema.json",
  "autoCompression": {
    "enabled": true,
    "contextWindowRatio": 0.9,
    "tokenThreshold": 432000
  }
}
```

The first fold request goes out at the earlier of `contextWindowRatio` of the model's context window
and `tokenThreshold`. Every setting is described in [compress.schema.json](compress.schema.json).

Edits to `compress.jsonc` apply from the next request or `/compress` command, without a server restart.
`enabled`, `commands.enabled`, a `deny` tool permission and the logging switches still need a restart.

## Use

- `/compress manage [instruction]` asks the agent for a fold now; the instruction guides its summary.
- `/compress prune [status|on|off]` pauses or resumes background pruning for this session. Outputs pruned so far
  stay pruned, because restoring them would rewrite the prompt cache and grow the context at once.
- `/compress context` and `/compress help` post feedback without a model call.
  OpenCode may hold that feedback in the session queue until the next delivery.
- `compress({ summary })` replaces the whole conversation with the summary after the current step.

State is stored under `$XDG_DATA_HOME/opencode/storage/plugin/compress`, with migration from the
legacy `dcp` directory. A session folded by an earlier release keeps showing its compressed blocks
`[bN]` until its next fold replaces them. Retired fields are ignored.

## Validate

```bash
npm run check
npm test
```

When this checkout's `dist` is loaded by a running server, use the isolated build procedure in
[AGENTS.md](AGENTS.md) instead; the normal build and test scripts replace `dist`.
