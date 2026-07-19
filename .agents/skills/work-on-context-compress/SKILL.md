---
name: work-on-context-compress
description: Build, debug, review, or release the opencode-context-compress TypeScript plugin. Use for changes involving `/compress manage`, `/compress auto`, map-first pinned compression, automatic compression policy or cooldowns, context maps, compression ranges, prompt transforms, management-turn cleanup, Session Goal continuation markers and overflow recovery, per-session persistence, OpenCode hooks or SDK compatibility, plugin configuration, generated prompts, tests, or committed `dist/` artifacts in this repository.
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
- Use `lib/hooks.ts` for transform, slash-command routing, and same-turn map-pin invalidation/reconciliation (normal pins clear immediately on a later real user; management pins from successful `compress_map` survive admission for the in-flight `compress`, then clear on next transform if unused).
- Use `lib/commands/manage.ts` and `lib/auto-compression.ts` for manual and automatic management-turn initiation. Both open map-first reminders with no injected map text; automatic turns stage protected-tail IDs at start. Overflow recovery stages one automatic turn with `goalOverflowRecovery`.
- Use `lib/goal.ts` for Goal continuation recognition, overflow error detection, and post-compress Goal resume (feature-detected public API + owner CAS on `id` / `status` / `time.updated` only; no Goal token/elapsed metrics).
- Use `lib/auto-policy.ts` for effective global/session policy and transcript-derived cooldown logic; use `lib/commands/auto.ts` for session-scoped `/compress auto` controls, including idempotent on/off. Visible-user boundaries exclude recognized Goal continuations.
- Use `lib/messages/context-map.ts` for model-visible range labels, execution-skeleton creation, and pin-backed range resolution; use `lib/messages/compress-transform.ts` for persisted overlays and management residue cleanup (Goal continuations do not bound open management).
- Use `lib/hooks.ts` so Goal continuations do not invalidate an open management map pin.
- Use `lib/tools/compress-map.ts` for normal or managed map authority: build history before the current visible-user/management boundary, reapply automatic protected IDs when relevant, persist one same-turn pin, then return map text.
- Use `lib/tools/compress.ts` for pin-backed range validation, no live transcript rebuild, atomic state commits, pin clear, completion markers, optional Goal overflow resume after success, and the tool receipt.
- Use `lib/state/` for per-session state and disk compatibility, including the single optional `compressionMapSnapshot` and optional `goalOverflowRecovery`. Never replace `SessionStateManager` with shared singleton state.
- Use `lib/sdk/client.ts` for all session/TUI calls, including feature-detected `getSessionGoal` / `resumeSessionGoal`. Local Goal types match the reduced host response (`id`, `sessionID`, `objective`, `status`, `time`); recovery needs only `id`, `status`, `time.updated`. Keep both nested v1 plugin-host and flat v2 SDK request shapes working; absent Goal API remains graceful.
- Edit prompt sources in `lib/prompts/*.md`; never hand-edit `_codegen` or `dist` as the source of truth.

## Preserve the contracts

- Keep compression state scoped by session ID and persisted atomically before hiding any original context.
- Keep management map-first: reminders never inject `<compress-context-map>`; the agent must call `compress_map` before `compress`; both tools must be available or management does not open.
- Keep the same map-first tools agentically available during normal work. Normal maps exclude the current visible user request and subsequent in-progress activity; successful normal compression does not invent a management completion marker.
- Keep at most one durable same-turn execution skeleton per session. Replace it on successful `compress_map`; clear it on successful `compress`, new management turn, or compaction. Normal pins invalidate immediately on a later real visible user; management pins from successful `compress_map` survive that admission so the in-flight management `compress` can consume them, and otherwise clear on the next transform/reconciliation before the later user's provider request. No queue, worker, or extra pin state. Goal synthetic continuations remain non-invalidating. Do not accumulate snapshot history, map text, previews, or transcript copies.
- Keep `compress` pinned to the map the agent was shown. Resolve ranges from that skeleton's physical IDs/metrics; do not fetch/rebuild a live renumbered map for execution.
- Keep session auto overrides and the cooldown anchor durable. Global `autoCompression.enabled: false` remains the master kill switch, and cooldown progress is derived idempotently from the transcript. `/compress auto on|off` must no-op when the effective state already matches.
- Serialize every durable mutation for a session with `SessionStateManager.runExclusive(sessionId, ...)`; save a candidate before committing it to live state so concurrent paths cannot overwrite each other.
- Let unexpected failures reach the command, event, or tool boundary. Do not report success after a failed prompt or state write, and do not return an executable-looking map when pin persistence fails.
- Keep manual `/compress manage` model-directed. Apply automatic-only safety rules only to automatic management turns.
- Keep the management trigger and tool activity visible while a turn is open. After success, remove management scaffolding without breaking the completing tool-call/result pair.
- Keep summaries dense enough to resume work: objective, decisions, constraints, edits, commands/results, failures, pending work, and exact next action.
- Keep native OpenCode auto-compaction from racing plugin-owned automatic compression when that feature is enabled.
- Keep Session Goal compatibility fail-open: exact synthetic continuation prefix + `Goal reference: goa_* <timestamp>` for boundary/pin exceptions only; never strip Goal text from model context; never pause/resume Goals around ordinary management turns; do not reintroduce Goal token/elapsed fields.
- Keep overflow recovery one-shot and owner-CAS gated on Goal `id` / `status` / `time.updated`; absence of Goal APIs disables only recovery.
- Keep subagent behavior explicit. The current transform/state rules and effective tool permissions decide whether a session is eligible; do not silently broaden the scope.
- Keep `dist/` synchronized because this repository and local installs load built files directly.

## Implement and prove changes

1. Add the smallest boundary-level change that preserves the runtime contracts.
2. Add focused tests for the state transition or provider-visible transcript, including failure and reload paths when persistence changes.
3. Run `npm run generate:prompts` after prompt edits.
4. Run the narrow test file while iterating.
5. Run `npm run typecheck`, `npm test`, and `npm run build` before handoff. `npm test` already rebuilds, but run the final build after the last edit so committed `dist/` is current.
6. Inspect `git diff --check`, the final dirty tree, and the built entrypoint loaded by the live config.

For message-lifecycle changes, verify the immediate continuation after `compress`, a later normal user turn, and reload from persisted state. For automatic triggering, verify threshold selection, duplicate-event suppression, in-flight management suppression, protected-tail enforcement, and task continuation. For map-first/pin work, verify no injected map in reminders, `compress_map` before `compress`, pin replace/clear lifecycle (normal immediate invalidation vs management survival then transform clear), no transcript rebuild inside `compress`, sparse-fetch honesty, dual-tool availability gates, and idempotent `/compress auto on|off`. For Goal compatibility, verify marker boundary/pin exceptions, one-shot overflow owner recovery, stale/manual/no-API/resume-failure paths, and that ordinary compression still works without Goal APIs. When the OpenCode fork is available, joint cases in `packages/opencode/test/session/prompt.test.ts` load this repo’s real `dist`.

Report what is proven by tests or live inspection separately from remaining provider/model limitations. Do not install, restart, or edit OpenCode config unless Aiden explicitly requests it.
