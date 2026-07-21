<div align="center">

<img src=".github/assets/hero.jpg" alt="opencode-context-compress hero" width="100%">

# opencode-context-compress

**Model-directed context compression, with manual control and automatic safety.**

[![npm version](https://img.shields.io/npm/v/%40skybluejacket%2Fopencode-context-compress?color=369eff&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@skybluejacket/opencode-context-compress)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

</div>

OpenCode plugin for model-directed context compression. Run it explicitly with `/compress manage`,
or let the plugin initiate the same workflow before a primary session fills its context window.

## Core Behavior

- No separate summarizer or hidden compaction model: the active agent writes one truthful summary
  and a short block title; the plugin always selects the eligible history itself.
- Manual compression runs when you trigger `/compress manage`.
- Automatic compression runs once when completed assistant usage reaches the earlier of 90% of
  the model-reported context window or 350,000 tokens by default.
- When plugin-owned automatic compression is enabled, native OpenCode auto-compaction is disabled
  through the plugin config hook so the two mechanisms cannot race.
- One public tool: `compress({ summary, topic })`. Availability alone does not authorize autonomous
  use; call it only from a management reminder or an explicit user request to compress context.
- Manual management, automatic management, and authorized normal-turn use all share the same
  deterministic selection: every eligible uncompressed message after the newest existing `[bN]`
  block, excluding the newest configured execution steps (`protectedTurns`, default `3`).
- Existing compressed blocks are immutable. A new fold never selects, alters, reorders, or removes
  them.
- Only the `compress` tool must be permitted. If it is denied, management does not open an unusable
  model turn.
- A successful `compress` call is the finish line: the fold takes effect immediately for the
  next model turn, with no need to wait for a further user message.
- After a successful compression, automatic and model-initiated compression pause for the next
  three completed primary-session assistant responses. An explicit `/compress manage` may override
  this cooldown.
- After that management turn completes, its trigger, tool calls, tool outputs, and assistant
  chatter are hidden from future model prompts.
- Automatic turns require a high-detail current-task handoff and tell the agent to resume the
  interrupted task immediately when work was genuinely still active.

## Commands

- `/compress` or `/compress help`: show command help.
- `/compress manage [instruction]`: send a self-contained context-management reminder that requires one `compress` call with `summary` and `topic`; optional trailing text is passed to the agent as the user's specific compression instruction.
- `/compress context`: show token usage breakdown for the current session.
- `/compress stats`: show session and all-time compression totals.
- `/compress auto` or `/compress auto status`: show this session's effective automatic-compression settings and cooldown.
- `/compress auto on|off`: enable or disable automatic compression for this session. Already-matching effective state is a no-op that reports the source without writing a redundant override.
- `/compress auto threshold N`: override this session's absolute token threshold.
- `/compress auto ratio N`: override this session's context-window threshold with an integer percentage from 1 to 99.
- `/compress auto reset`: clear this session's threshold and ratio overrides without changing its on/off setting or cooldown.

`/compress manage` is the only command that intentionally creates a model-visible turn.
All `/compress auto` feedback is user-only. Session `off` disables every automatic trigger for
that session—both the absolute threshold and the context-window ratio—until it is turned on again.
The process-level `autoCompression.enabled: false` setting remains authoritative and cannot be
overridden from a session.

## Agentic Workflow

During normal work the agent may call `compress` only when the current user message explicitly
authorizes compression. `/compress manage` and an automatic threshold trigger open a model-visible
management turn with a self-contained reminder. In every authorized path the agent:

1. Review the current conversation and reconcile chronology (later evidence supersedes stale plans).
2. Call `compress` once with:
   - `summary`: the durable replacement for all eligible uncompressed history after the newest existing block
   - `topic`: a short title for the new compressed block
3. Treat a success receipt as durable and already active. Do not call `compress` again that turn.

The plugin selects the span deterministically inside that one call:

1. Resolve the compression boundary (active management trigger, or the visible user turn that owns
   the executing tool call).
2. Apply existing compression transforms so historical blocks occupy their canonical positions.
3. Take every uncompressed message after the newest existing block (or all uncompressed messages
   when no block exists).
4. Exclude the newest `protectedTurns` execution steps so they remain verbatim after the fold.
5. Never select a block or any message ID belonging to an existing block.
6. Atomically persist the new block, IDs, stats, management completion marker when applicable, and
   cooldown anchor before returning success.

If nothing eligible remains, the tool returns a truthful empty result and leaves state unchanged.
Normal-turn ownership is tied to the executing tool call; a later queued user cannot fold the wrong
turn. Ambiguous ownership fails closed without changing state.

Automatic triggering is event-driven, per session, and deduplicated. It observes completed
provider usage; it does not open a management turn on every response. Subagent sessions remain
excluded because their transform and effective tool-permission contract is different from primary
sessions.

Normal-turn compression still respects the three-response post-compression cooldown. During
cooldown, `compress` refuses model-initiated use and asks the agent to wait; an explicit user
`/compress manage` remains the override.

While the management turn is still open, the agent can see the reminder and tool activity. The
instant `compress` succeeds, the manage prompt and status notifications are hidden from the very
next model turn — no further user message is needed. The completed `compress` tool call itself
stays briefly because providers require the tool-call/result pair; its submitted input is left
literal so the agent cannot mistake a synthetic marker for what it submitted. On later turns, the
model-visible context contains only compressed `[bN]` blocks, normal conversation between
compression runs, the preserved newest execution steps, and model-visible Goal continuation text.
The cleanup leaves no marker or placeholder behind.

## Installation

### npm (Recommended)

```bash
npm install @skybluejacket/opencode-context-compress
```

Then add it to your config:

| Platform | Global | Project-level |
| --- | --- | --- |
| OpenCode | `~/.config/opencode/opencode.jsonc` | `.opencode/opencode.jsonc` |

```jsonc
{
    "plugin": ["@skybluejacket/opencode-context-compress"]
}
```

### From Source

Clone the repo, build, and reference the compiled entry file directly:

```bash
git clone https://github.com/AidenGeunGeun/opencode-context-compress.git
cd opencode-context-compress
npm install
npm run build
```

```jsonc
{
    "plugin": ["file:///absolute/path/to/opencode-context-compress/dist/index.js"]
}
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
    "protectedTurns": 3,
    "commands": {
        "enabled": true,
        "protectedTools": ["task", "todowrite", "todoread", "compress", "batch", "plan_enter", "plan_exit"]
    },
    "autoCompression": {
        "enabled": true,
        "contextWindowRatio": 0.9,
        "tokenThreshold": 350000
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

`protectedTurns` is general compression policy (manual, automatic, and authorized normal paths).
Default is `3`. The legacy nested key `autoCompression.protectedTurns` is still accepted as a
fallback when the top-level key is absent; an explicitly configured top-level value wins.

## Persistence

Session state is stored at:

- `~/.local/share/opencode/storage/plugin/compress/<sessionId>.json`

Stored fields include:

- compressed tool IDs
- compressed message IDs
- compression summaries (`[bN]` blocks: anchor, message IDs, summary, topic)
- manual and automatic management-turn cleanup markers
- per-session compression stats
- session automatic-compression overrides and the post-compression cooldown anchor
- optional one-shot Goal overflow recovery owner (`goalOverflowRecovery`: overflow message id +
  `{ goalID, timeUpdated }`) when the host blocked a Goal on `ContextOverflowError`

Durable mutations for one session run through `SessionStateManager.runExclusive(sessionId, ...)`.
A candidate state is saved atomically before it is committed to memory.

The raw conversation history still exists in OpenCode storage, but completed management machinery
is suppressed from future model prompts. Restarting the session reloads the saved cleanup markers,
so old management turns do not reappear in the model-visible stream.

### Maintainer compatibility notes

- Old completed session state continues to load and render. Existing `[bN]` anchors and ordering
  are unchanged.
- Historical management residue that still contains retired tool parts is cleaned up so old
  completed management machinery stays hidden; that cleanup path is not part of the current
  agent-facing workflow.
- Stale persisted `compressionMapSnapshot` data is ignored and cleared through the normal state
  lifecycle. It is never executed and is not replaced by another durable snapshot system.
- The legacy `"dcp"` storage directory string remains for migration from older installs.

## Session Goal compatibility

This plugin coexists with OpenCode’s native Session Goal (`/goal`) when the host exposes it. Goal
lifecycle stays host-owned; the plugin only recognizes Goal continuation text at management
boundaries and may resume a blocked Goal after one bounded overflow recovery.

Host Goal responses may include objective and timestamps; for overflow recovery the plugin only
requires Goal `id`, `status`, and `time.updated` (lifecycle owner/version CAS — not an elapsed
metric). There is no Goal token/elapsed accounting on the host API, and this plugin does not track
Goal metrics.

### Continuation marker (management boundary only)

Goal continuations are synthetic user text that remains **model-visible** (not `ignored`). Stable
recognition requires all of:

1. User text part with `synthetic: true`
2. Exact prefix: `Continue pursuing the active session goal.`
3. A line `Goal reference: goa_* <timestamp>` (Goal id + owner `time.updated`)

The plugin ignores that combination only as a management-boundary exception so ordinary Goal
steering does not close an open management turn. The marker is **not** stripped from model context.
Recognition is fail-open: missing prefix or reference → treat as a normal user boundary.

Do not pause/resume the Goal around ordinary automatic management turns. Host prompt admission may
self-heal when a newer durable user (including a management turn) was admitted while a joined run
exits; that recheck is generic OpenCode behavior, not plugin-specific.

### Overflow recovery

When automatic compression is enabled and the host reports assistant `ContextOverflowError` for a
session whose Goal is `blocked`:

1. Store the exact owner `{ goalID, timeUpdated }` with the overflow message id in per-session state.
2. Open **one** recovery management turn that uses the same single `compress` workflow.
3. After successful `compress`, feature-detect `session.goal` / `session.goalUpdate` and resume only
   if the same Goal is still blocked with the same owner token (optional CAS on the host resume API).
4. Never resume after edit, replacement, manual pause, completion, or a different blocked Goal.
5. Failed compression leaves the Goal blocked and does not loop.
6. Hosts without Goal APIs: recovery is disabled only; ordinary automatic compression still works
   (absent Goal methods remain graceful — feature detection returns no Goal data and skips resume).

Implementation: `lib/goal.ts`, SDK adapters in `lib/sdk/client.ts` (`SessionGoalInfo`: `id`,
`sessionID`, `objective`, `status`, `time.{created,updated}`), state field `goalOverflowRecovery`,
auto handler in `lib/auto-compression.ts`, post-success path in `lib/tools/compress.ts`, marker
exceptions in transform/policy/hooks.

### Tests and dist

- Plugin source tests: `tests/goal-compatibility.test.ts`, overflow cases in
  `tests/auto-compression.test.ts` (marker boundary, one-shot recovery, owner payload, stale/manual/
  no-API/resume failure).
- Joint host tests live in the OpenCode fork
  (`packages/opencode/test/session/prompt.test.ts`): real built `dist/index.js` loaded against
  scripted local-provider OpenCode for common Goal+compression, overflow success once, failed
  compression no loop, and stale edit/manual pause no resume.
- `npm test` rebuilds committed `dist/` and must pass before handoff.
- No install/restart/config edit is required for docs-only or already-referenced `file://` loads;
  restart OpenCode only after Aiden chooses to install/use a newly built plugin or host binary.

Future merge/removal: if OpenCode drops Goals or changes continuation text, delete marker exceptions
and overflow recovery here and rebuild `dist/`. Do not teach broad OpenCode core about this plugin.

## Development

```bash
npm install
npm run generate:prompts
npm run typecheck
npm test
npm run build
```

Prompt utility docs are in `scripts/README.md`.
The project-scoped agent onboarding skill is in `.agents/skills/work-on-context-compress/`.

## License

MIT
