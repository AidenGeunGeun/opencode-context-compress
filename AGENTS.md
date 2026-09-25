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
- Start management turns with `session.prompt()`.
- Mark management prompts with `opencode.context-compress.management` metadata so side chats hide
  internal compression exchanges without hiding user messages.
- Automatic prompts use a stable ID derived from the session and completed triggering message so the
  host deduplicates admission across plugin instances. Manual prompts retain fresh IDs. Local locks
  serialize only one state-manager instance. Event ownership compares directory and workspace ID
  when the event carries them; public Session lookup supplies the directory fallback.
- Register `compress` and `squash` with Zod input schemas.
- Apply durable folds in the session `context` hook.
- Observe automatic thresholds, forks, and native compaction through the event stream. Remap
  inherited compression references to copied message IDs before a fork's first model request;
  the context hook also recovers when its fork event was missed.
- Require `compaction.auto: false` in OpenCode configuration.

Compression selection is deterministic: exclude existing blocks, select eligible uncompressed
history after the newest block, and preserve the newest `protectedTurns` execution steps. `squash`
changes only a contiguous range of existing blocks. Durable state remains compatible with existing
blocks, management turns, cooldowns, auto overrides, and the legacy `dcp` migration directory;
ignore retired fields.

## Structure

- `index.ts` exports the Promise plugin.
- `lib/plugin.ts` registers commands, tools, hooks, and events.
- `lib/commands` implements command behavior.
- `lib/messages` owns projection, selection, transforms, cleanup, and notices.
- `lib/state` owns per-session locking, persistence, migration, and native-compaction reconciliation.
- `lib/tools` owns durable compress and squash writes.
- `lib/sdk` owns the client and session message listing.
- `lib/ui` owns notification rendering.
- `lib/*.ts` (auto-compression, auto-policy, config, logger, shared-utils, token-utils) own cross-cutting utilities.
- `lib/prompts/*.md` are sources; `lib/prompts/_codegen` is generated. Do not edit generated files directly.
- `compress.schema.json` is the JSON Schema for plugin configuration.
- Build pipeline: `tsc` then `bun build index.ts --outdir dist` (ESM). The `prebuild` step runs `generate:prompts` first.

## Validation

```bash
npm run typecheck   # generates prompts, then tsc --noEmit
npm run build       # clean && tsc && bun build index.ts → dist (ESM)
npm test            # builds first, then node --import tsx --test tests/*.test.ts
```

Keep `dist/index.js` at the root of `dist`, because OpenCode configuration points to the `dist`
directory. For host smoke tests, isolate both `XDG_CONFIG_HOME` and `XDG_DATA_HOME`; never use live
services, databases, or configuration.

For a live-loaded checkout, do not run `npm run build` or `npm test`: they clean and replace the watched `dist`. Prepare a candidate without activating it:

```bash
npm run typecheck
node --import tsx --test tests/prompts.test.ts
compression_stage=$(mktemp -d /private/tmp/opencode-compress-stage.XXXXXX)
./node_modules/.bin/tsc --outDir "$compression_stage/dist"
bun build index.ts --outdir "$compression_stage/dist" --entry-naming index.js --target bun --format esm --packages external --sourcemap=linked
```

Only replace active `dist` at an explicitly approved quiet boundary. Verify the live bundle hash is unchanged while preparing the candidate.
