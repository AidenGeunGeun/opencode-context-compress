---
name: work-on-context-compress
description: Build, debug, review, or release the opencode-context-compress TypeScript plugin. Use for changes involving `/compress manage`, `/compress auto`, automatic compression policy or cooldowns, context maps, compression ranges, prompt transforms, management-turn cleanup, per-session persistence, OpenCode hooks or SDK compatibility, plugin configuration, generated prompts, tests, or committed `dist/` artifacts in this repository.
---

# Work on Context Compress

Treat this as a stateful OpenCode protocol plugin, not a text-rewriting utility. Preserve provider-valid message/tool structure, per-session isolation, persisted compression decisions, and the user's active task.

## Orient first

1. Read the repository `AGENTS.md` completely.
2. Run `git status --short --branch` and inspect relevant diffs before editing. Preserve unrelated and pre-existing changes.
3. Inspect the live OpenCode config that loads the plugin. Check both `~/.config/opencode/` and `OPENCODE_CONFIG_DIR` when set; do not assume the active checkout or compaction setting.
4. Read the narrow source path and its tests before changing behavior.

## Navigate the runtime

- Start at `index.ts` for registered hooks, tools, config mutation, and feature enablement.
- Use `lib/hooks.ts` for transform and slash-command routing.
- Use `lib/commands/manage.ts` and `lib/auto-compression.ts` for manual and automatic management-turn initiation.
- Use `lib/auto-policy.ts` for effective global/session policy and transcript-derived cooldown logic; use `lib/commands/auto.ts` for session-scoped `/compress auto` controls.
- Use `lib/messages/context-map.ts` for model-visible range labels and `lib/messages/compress-transform.ts` for persisted overlays and management residue cleanup.
- Use `lib/tools/compress.ts` for range validation, atomic state commits, completion markers, and the tool receipt.
- Use `lib/state/` for per-session state and disk compatibility. Never replace `SessionStateManager` with shared singleton state.
- Use `lib/sdk/client.ts` for all session/TUI calls. Keep both nested v1 plugin-host and flat v2 SDK request shapes working.
- Edit prompt sources in `lib/prompts/*.md`; never hand-edit `_codegen` or `dist` as the source of truth.

## Preserve the contracts

- Keep compression state scoped by session ID and persisted atomically before hiding any original context.
- Keep session auto overrides and the cooldown anchor durable. Global `autoCompression.enabled: false` remains the master kill switch, and cooldown progress is derived idempotently from the transcript.
- Serialize every durable mutation for a session with `SessionStateManager.runExclusive(sessionId, ...)`; save a candidate before committing it to live state so concurrent paths cannot overwrite each other.
- Let unexpected failures reach the command, event, or tool boundary. Do not report success after a failed prompt or state write.
- Keep manual `/compress manage` model-directed. Apply automatic-only safety rules only to automatic management turns.
- Keep the management trigger and tool activity visible while a turn is open. After success, remove management scaffolding without breaking the completing tool-call/result pair.
- Keep summaries dense enough to resume work: objective, decisions, constraints, edits, commands/results, failures, pending work, and exact next action.
- Keep native OpenCode auto-compaction from racing plugin-owned automatic compression when that feature is enabled.
- Keep subagent behavior explicit. The current transform/state rules and effective tool permissions decide whether a session is eligible; do not silently broaden the scope.
- Keep `dist/` synchronized because this repository and local installs load built files directly.

## Implement and prove changes

1. Add the smallest boundary-level change that preserves the runtime contracts.
2. Add focused tests for the state transition or provider-visible transcript, including failure and reload paths when persistence changes.
3. Run `npm run generate:prompts` after prompt edits.
4. Run the narrow test file while iterating.
5. Run `npm run typecheck`, `npm test`, and `npm run build` before handoff. `npm test` already rebuilds, but run the final build after the last edit so committed `dist/` is current.
6. Inspect `git diff --check`, the final dirty tree, and the built entrypoint loaded by the live config.

For message-lifecycle changes, verify the immediate continuation after `compress`, a later normal user turn, and reload from persisted state. For automatic triggering, verify threshold selection, duplicate-event suppression, in-flight management suppression, protected-tail enforcement, and task continuation.

Report what is proven by tests or live inspection separately from remaining provider/model limitations.
