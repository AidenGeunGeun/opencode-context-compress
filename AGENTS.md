# OpenCode Context Compress

Target the OpenCode Promise plugin API pinned in `package.json`. Do not reintroduce fork
`server`/`setup` dual hosting, Session Goal integration, persona-specific prompts, command
interception hooks, or a compaction-veto hook.

## Setup

```bash
npm install
```

Requires `bun` (build runtime) and `tsc` (TypeScript compiler, resolved via `node_modules/.bin`). The `prebuild` script auto-generates prompt files from `lib/prompts/*.md` before compiling.

## Contract

- Register `/compress` through `command.transform(...draft.add)` and its `execute` callback.
- Read authoritative projected history with `session.context()`.
- Return command/status feedback with `session.synthetic({ resume: false })` so it never starts a
  model run. Clients must show admitted feedback immediately and in full; queue admission alone does
  not verify that behavior. Do not enable `resume` merely to make feedback visible.
- Send fold requests with `session.prompt()` (steer, resume). The automatic request uses a stable ID
  derived from the session and the triggering message so the host deduplicates admission across
  plugin instances; `/compress manage` uses a fresh ID. Event ownership compares directory and
  workspace ID when the event carries them; public Session lookup supplies the directory fallback.
- Register `compress` with a Zod input schema.
- Observe the token threshold, forks, and compaction through the event stream. Remap inherited
  compression references to copied message IDs before a fork's first model request; the context hook
  also recovers when its fork event was missed.
- Keep `compaction.auto: false` in OpenCode configuration. A fold is a manual compaction and does not
  need it; automatic compaction would fold at a token count without the documentation pass.

A fold goes through OpenCode's compaction (`lib/plugin.ts`, `lib/tools/compress.ts`). `compress`
saves the agent's summary in memory and calls `session.compact()`, which core runs right after the
step. The `compaction` hook then sets `event.result` to that summary, so core makes no model
request, and `metadata.keepID: undefined`, so core keeps no recent messages beside it: they would
repeat the summary, loaded skill text, and edit inputs. Core loads the instruction baseline fresh at
every compaction, which the earlier block design never triggered. The summary stays in memory until
the compaction ends, fails, or is cancelled in the inbox; the fold request skips a step whose summary is pending,
because a request sent then arrives after the fold and folds again. A compaction without a pending
summary is a manual `/compact`: its request gets the same message list and Anthropic headers as a
primary request so it reads the prompt cache.

The fold request (`lib/fold-request.ts`) is sent when a step ends at the threshold and again at each
further 100,000 tokens. Its level lives in memory only, so a reload sends one extra request to a
session still above the threshold. No repeat is queued while the previous request is undelivered,
because it would arrive after the fold and fold again. A session with a parent gets
`fold-documentation-subagent.md` as its documentation step: the parent owns the documentation, so a
subagent carries its findings in the summary instead of editing files. A subagent step that ends its
turn gets no request, because that last message is the report its parent receives.

Sessions folded by releases before 2026-11-10 hold compressed blocks and management turns in their
state. `lib/messages/compress-transform.ts`, `blocks.ts`, and `legacy-residue.ts` keep rendering
them byte for byte until the session's next fold, when `reconcileSessionLifecycle` clears them. Do
not change that rendering; delete it once no live session holds a block. Durable state also stays
compatible with the legacy `dcp` migration directory; ignore retired fields.

Background pruning (`lib/messages/prune.ts`) is programmatic and never prompts the agent. Its marks
live in `compressed.toolIds` and only grow, so request bytes change only at a pruning event. On
Anthropic it sends the prune frontier to the next primary request in the `x-opencode-cache-anchors`
header, which the `anthropic-auth` plugin turns into a cache marker before signing. The prune rule
prices Anthropic rewrites from that marker, so it depends on that plugin.

Never change an earlier message in an Anthropic request. Anthropic drops every thinking block after a
changed message, which cost Opus 5.5 its recent reasoning at every prune (2026-11-02). Anthropic requests
show only the stubs in `anthropicStubIds`, fixed at a session's first Anthropic request and persisted with the
session state, since losing it on reload stubs results Anthropic had only cleared; every later
prune reaches Anthropic as server-side clearing (`clear_tool_uses_20250919`), which the API does not
count as an edit. The `x-opencode-tool-clearing` header names the oldest call to keep and the protected
tools, and `anthropic-auth` turns it into the clearing config before signing. The full Anthropic thinking and cache
rules are in `anthropic-auth`'s README, under Thinking and prompt cache.

OpenAI has no such marker. On the ChatGPT token-sharing route, a cache entry exists only at the exact
end of an earlier request, and the API rejects `prompt_cache_breakpoint` and `prompt_cache_options`
with "not supported on this model" (gpt-5.6-sol through gpt-6.1, measured 2026-11-02). After an
OpenAI prune the cache resumes at an earlier request's end, usually the previous prune's resume point,
so the rule prices the rewrite as the whole conversation. Client-side stubs cost OpenAI no reasoning: token deltas
show the encrypted reasoning of earlier steps carried through prunes and user turns (gpt-6.x, 2026-11-03).

After a fold the summary is the only message the agent sees, so the plugin appends `FOLD_NOTE` to it
to say how to resume. The compress tool description goes out with every request, so changing it
drops every Anthropic session's thinking and rewrites its cache once. Batch such changes; put
turn-specific guidance in the fold request (`lib/prompts/fold-request.md`) instead.

## Structure

- `index.ts` exports the Promise plugin.
- `lib/plugin.ts` registers commands, tools, hooks, and events.
- `lib/commands` implements command behavior.
- `lib/messages` owns projection, pruning, and the rendering of earlier releases' blocks.
- `lib/state` owns per-session locking, persistence, migration, fork remapping, and compaction
  reconciliation.
- `lib/tools` owns the compress tool.
- `lib/sdk` owns the client and session message listing.
- `lib/ui` owns command feedback messages.
- `lib/*.ts` (fold-request, config, logger, shared-utils, token-utils) own cross-cutting utilities.
- `lib/prompts/*.md` are sources; `lib/prompts/_codegen` is generated. Do not edit generated files directly.
- `compress.schema.json` is the JSON Schema for plugin configuration.
- Build pipeline: `tsc` then `bun build index.ts --outdir dist` (ESM). The `prebuild` step runs `generate:prompts` first.

## Validation

```bash
npm run check       # Biome format and lint, then typecheck of source, tests, and scripts
npm run fix         # apply Biome formatting and safe fixes
npm run build       # clean && tsc && bun build index.ts → dist (ESM)
npm test            # builds first, then node --import tsx --test tests/*.test.ts
```

Every change passes `npm run check` with zero diagnostics, tests included. Fix findings instead of
adding suppressions or relaxing rules.

Keep `dist/index.js` at the root of `dist`, because OpenCode configuration points to the `dist`
directory. For host smoke tests, isolate both `XDG_CONFIG_HOME` and `XDG_DATA_HOME`; never use live
services, databases, or configuration.

For a live-loaded checkout, do not run `npm run build` or `npm test`: they clean and replace the watched `dist`.
Prepare a candidate without activating it:

```bash
npm run typecheck
node --import tsx --test tests/fold.test.ts
compression_stage=$(mktemp -d /private/tmp/opencode-compress-stage.XXXXXX)
./node_modules/.bin/tsc --outDir "$compression_stage/dist"
bun build index.ts --outdir "$compression_stage/dist" --entry-naming index.js --target bun --format esm --packages external --sourcemap=linked
```

Only replace active `dist` at an explicitly approved quiet boundary. Verify the live bundle hash is unchanged while
preparing the candidate.
