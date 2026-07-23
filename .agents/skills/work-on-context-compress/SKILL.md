---
name: work-on-context-compress
description: Build, debug, review, or release the opencode-context-compress TypeScript plugin. Use for changes involving `/compress manage`, `/compress auto`, deterministic single-tool compression, automatic compression policy or cooldowns, protectedTurns, prompt transforms, management-turn cleanup, Session Goal continuation markers and overflow recovery, per-session persistence, OpenCode hooks or SDK compatibility, plugin configuration, generated prompts, tests, or committed `dist/` artifacts in this repository.
---

# Work on Context Compress

Treat this as a stateful OpenCode protocol plugin, not a text-rewriting utility. Preserve provider-valid message/tool structure, per-session isolation, persisted compression decisions, and the user's active task.

## Orient first

1. Read the repository `AGENTS.md` completely.
2. Run `git status --short --branch` and inspect relevant diffs before editing. Preserve unrelated and pre-existing changes.
3. Inspect the live OpenCode config that loads the plugin. Check both `~/.config/opencode/` and `OPENCODE_CONFIG_DIR` when set; do not assume the active checkout or compaction setting.
4. Read the narrow source path and its tests before changing behavior.

## Navigate the runtime

- Start at `index.ts` for registered hooks, the single `compress` tool, config mutation, and feature enablement.
- Use `lib/hooks.ts` for transform, slash-command routing, and chat.message variant caching. Goal continuations do not bound open management turns.
- Use `lib/commands/manage.ts` and `lib/auto-compression.ts` for manual and automatic management-turn initiation. Both open one-call reminders requiring `compress({ summary, topic })`; only the `compress` tool gates start. Automatic turns may skip when the protected tail covers all selectable history. Overflow recovery stages one automatic turn with `goalOverflowRecovery`.
- Use `lib/goal.ts` for Goal continuation recognition, overflow error detection, and post-compress Goal resume (feature-detected public API + owner CAS on `id` / `status` / `time.updated` only; no Goal token/elapsed metrics).
- Use `lib/auto-policy.ts` for effective global/session policy and transcript-derived cooldown logic; use `lib/commands/auto.ts` for session-scoped `/compress auto` controls, including idempotent on/off. Visible-user boundaries exclude recognized Goal continuations.
- Use `lib/messages/context-map.ts` for deterministic span selection (`selectDeterministicCompressionSpan`) and automatic selectable-history checks; use `lib/messages/compress-transform.ts` for persisted overlays and management residue cleanup (Goal continuations do not bound open management).
- Use `lib/messages/legacy-residue.ts` only for historical completed-management cleanup, including residual retired tool parts from older sessions.
- Use `lib/tools/compress.ts` for the public tool: non-empty `summary`/`topic`, boundary ownership, deterministic selection with `protectedTurns`, atomic `runExclusive` persistence, management completion markers, cooldown anchor, optional Goal overflow resume after success, and the tool receipt.
- Use `lib/state/` for per-session state and disk compatibility, including optional `goalOverflowRecovery` and ignore/clear of stale `compressionMapSnapshot` (never execute it). Never replace `SessionStateManager` with shared singleton state.
- Use `lib/sdk/client.ts` for all session/TUI calls, including feature-detected `getSessionGoal` / `resumeSessionGoal`. Local Goal types match the reduced host response (`id`, `sessionID`, `objective`, `status`, `time`); recovery needs only `id`, `status`, `time.updated`. Keep both nested v1 plugin-host and flat v2 SDK request shapes working; absent Goal API remains graceful.
- Use `lib/config.ts` for top-level `protectedTurns` (default `3`) and the legacy nested `autoCompression.protectedTurns` fallback when the top-level key is absent.
- Edit prompt sources in `lib/prompts/*.md`; never hand-edit `_codegen` or `dist` as the source of truth. Agent-facing prompts must describe only the current single-tool happy path.

## Preserve the contracts

- Keep compression state scoped by session ID and persisted atomically before hiding any original context.
- Keep ordinary `compress({ summary, topic })` deterministic and range-free. The separate public `squash({ from, to, summary, topic })` tool is authorized only by the current user's active `/compress squash` turn; do not introduce any other range, map, pin, or snapshot workflow.
- Keep ordinary selection identical across manual, automatic, and authorized normal paths: all eligible uncompressed history after the newest existing block, excluding the newest `protectedTurns` execution steps. Existing blocks are immutable outside explicit squash.
- Keep management/automatic start gated on `compress` alone. Availability does not authorize autonomous normal-turn compression without an explicit user request or management reminder.
- Keep session auto overrides and the cooldown anchor durable. Global `autoCompression.enabled: false` remains the master kill switch, and cooldown progress is derived idempotently from the transcript. `/compress auto on|off` must no-op when the effective state already matches. Explicit `/compress manage` may override cooldown.
- Serialize every durable mutation for a session with `SessionStateManager.runExclusive(sessionId, ...)`; save a candidate before committing it to live state so concurrent paths cannot overwrite each other.
- Let unexpected failures reach the command, event, or tool boundary. Do not report success after a failed prompt or state write. Empty eligible history must leave state unchanged and report truthfully.
- Keep normal-turn boundary ownership tied to the executing tool call; fail closed on ambiguous ownership or a racing later visible user.
- Keep the management trigger and tool activity visible while a turn is open. After success, remove management scaffolding without breaking the completing tool-call/result pair.
- Keep summaries dense enough to resume work: objective, decisions, constraints, edits, commands/results, failures, pending work only when still true, and exact next action only when one exists. Later evidence supersedes stale plans; do not invent completion or reopen finished work.
- Keep native OpenCode auto-compaction from racing plugin-owned automatic compression when that feature is enabled.
- Keep Session Goal compatibility fail-open: exact synthetic continuation prefix + `Goal reference: goa_* <timestamp>` for boundary exceptions only; never strip Goal text from model context; never pause/resume Goals around ordinary management turns; do not reintroduce Goal token/elapsed fields.
- Keep overflow recovery one-shot and owner-CAS gated on Goal `id` / `status` / `time.updated`; absence of Goal APIs disables only recovery.
- Keep subagent behavior explicit. The current transform/state rules and effective tool permissions decide whether a session is eligible; do not silently broaden the scope.
- Keep legacy completed state loadable. Ignore/clear stale `compressionMapSnapshot`; preserve historical residue cleanup so old completed management machinery stays hidden. Do not teach current agents retired workflows.
- Keep `dist/` synchronized because this repository and local installs load built files directly.

## Implement and prove changes

1. Add the smallest boundary-level change that preserves the runtime contracts.
2. Add focused tests for the state transition or provider-visible transcript, including failure and reload paths when persistence changes.
3. Run `npm run generate:prompts` after prompt edits.
4. Run the narrow test file while iterating.
5. Run `npm run typecheck`, `npm test`, and `npm run build` before handoff. `npm test` already rebuilds, but run the final build after the last edit so committed `dist/` is current.
6. Inspect `git diff --check`, the final dirty tree, and the built entrypoint loaded by the live config.

For message-lifecycle changes, verify the immediate continuation after `compress`, a later normal user turn, and reload from persisted state. For automatic triggering, verify threshold selection, duplicate-event suppression, in-flight management suppression, protected-tail behavior across paths, and task continuation. For deterministic selection, verify no-block and existing-block histories, newest-block exclusion, `protectedTurns` default/legacy-fallback/precedence, empty eligible history, current-tool boundary ownership vs a racing later user, atomic persistence failure, and that agent-facing prompts contain no retired workflow terms. For Goal compatibility, verify marker boundary exceptions, one-shot overflow owner recovery, stale/manual/no-API/resume-failure paths, and that ordinary compression still works without Goal APIs. When the OpenCode fork is available, joint cases in `packages/opencode/test/session/prompt.test.ts` load this repo’s real `dist`.

Report what is proven by tests or live inspection separately from remaining provider/model limitations. Do not install, restart, or edit OpenCode config unless Aiden explicitly requests it.
