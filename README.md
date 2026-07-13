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

- No separate summarizer or hidden compaction model: the active agent chooses and summarizes the range.
- Manual compression runs when you trigger `/compress manage`.
- Automatic compression runs once when completed assistant usage reaches the earlier of 90% of
  the model-reported context window or 300,000 tokens by default.
- When plugin-owned automatic compression is enabled, native OpenCode auto-compaction is disabled
  through the plugin config hook so the two mechanisms cannot race.
- Both manual and automatic management use a map-first protocol: the reminder does not include a
  map; the agent must call `compress_map`, then `compress` against that same-turn snapshot.
- The same map-first tools are available agentically during normal work. A normal-turn map excludes
  the current visible user request and in-progress agent/tool activity, so only prior history is
  selectable.
- Both `compress_map` and `compress` must be permitted. If either tool is denied, management does
  not open an unusable model turn.
- A successful `compress` call is the finish line: the fold takes effect immediately for the
  next model turn, with no need to wait for a further user message.
- After a successful compression, automatic and model-initiated compression pause for the next
  three completed primary-session assistant responses. An explicit `/compress manage` may override
  this cooldown.
- After that management turn completes, its trigger, tool calls, tool outputs, map text, and
  assistant chatter are hidden from future model prompts.
- Automatic turns protect the three most recent OpenCode execution turns by default, require a
  high-detail current-task handoff, and tell the agent to resume the interrupted task immediately.

## Commands

- `/compress` or `/compress help`: show command help.
- `/compress manage [instruction]`: send a self-contained context-management reminder that requires `compress_map` then `compress`; optional trailing text is passed to the agent as the user's specific compression instruction.
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

During normal work the agent may choose this map-first flow itself. `/compress manage` and an
automatic threshold trigger additionally open a model-visible management turn with a self-contained
reminder and no map text. In either case the agent:

1. Call `compress_map` and read the returned `<compress-context-map>`. That successful same-turn
   snapshot becomes the sole execution source of truth.
2. Call `compress` once with a range and summary drawn from that map. Reasoning or other tools may
   run between the two calls; adjacency is not required.
3. Get back a short durable-success receipt (e.g. `Stored [b4] "..." durably; the fold is already in effect`), not a refreshed map —
   the fold is already in effect. Do not call either compression tool again that turn after success.

`compress` resolves the submitted range against the pinned physical IDs from the map the agent
actually saw. It does not fetch or renumber a live transcript map. A later successful
`compress_map` in the same turn replaces the pin; a failed map fetch or save leaves the last
successful same-turn pin intact and returns no new authoritative map. Explicit consolidation of
older `[bN]` blocks remains supported as a single `compress` call when the user asks for it.

Automatic triggering is event-driven, per session, and deduplicated. It observes completed
provider usage; it does not open a management turn on every response. Subagent sessions remain
excluded because their transform and effective tool-permission contract is different from primary
sessions. Automatic turns stage protected active-tail IDs at start and reapply them when the agent
opens the map.

Normal-turn compression still respects the three-response post-compression cooldown. Reading
`compress_map` remains available during cooldown, but `compress` asks the agent to wait and refresh
the map later; an explicit user `/compress manage` remains the override.

While the management turn is still open, the agent can see the reminder, map tool result, and
other tool activity. The instant `compress` succeeds, the manage prompt, map output, and status
notifications are hidden from the very next model turn — no further user message is needed. The
completed `compress` tool call itself stays briefly because providers require the tool-call/result
pair; its submitted input is left literal so the agent cannot mistake a synthetic marker for what
it submitted. On later turns, the model-visible context contains only compressed `[bN]` blocks,
normal conversation between compression runs, and the active tail. The cleanup leaves no marker or
placeholder behind.

## Context Map

`compress_map` returns the structured map the agent must use during either normal or managed work.
`compress` executes against that pinned same-turn snapshot, not a freshly rebuilt numbering:

```text
<compress-context-map>
[1] user: "Let's implement JWT auth"
[2-4] assistant: 5 tool calls - auth exploration (~1,240 tokens)
[b0] [compressed] "Prior database migration debugging" (~420 tokens)
[5] user: "Looks good, now add tests"
[6-8] assistant: 4 tool calls - test implementation (~2,180 tokens)
---
Total: 8 messages + 1 block | ~6,500 tokens
</compress-context-map>
```

During manual management, the agent decides what counts as the active tail. During automatic
management, recent protected entries are labeled `[protected active tail]`; the agent still chooses
the range, but `compress` rejects a range that crosses that safety boundary. Block labels follow
where their anchors appear in the conversation stream, so re-compressing one block does not
renumber unrelated blocks. Maps exclude the entire active management span so the agent cannot
select the reminder or its own compression-tool activity.

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
    "commands": {
        "enabled": true,
        "protectedTools": ["task", "todowrite", "todoread", "compress", "compress_map", "batch", "plan_enter", "plan_exit"]
    },
    "autoCompression": {
        "enabled": true,
        "contextWindowRatio": 0.9,
        "tokenThreshold": 300000,
        "protectedTurns": 3
    },
    "turnProtection": {
        "enabled": false,
        "turns": 4
    },
    "protectedFilePatterns": [],
    "tools": {
        "settings": {
            "protectedTools": ["task", "todowrite", "todoread", "compress", "compress_map", "batch", "plan_enter", "plan_exit"]
        },
        "compress": {
            "permission": "allow",
            "showCompression": false
        },
        "compress_map": {
            "permission": "allow"
        }
    }
}
```

## Persistence

Session state is stored at:

- `~/.local/share/opencode/storage/plugin/compress/<sessionId>.json`

Stored fields include:

- compressed tool IDs
- compressed message IDs
- compression summaries
- manual and automatic management-turn cleanup markers, including automatic protected-tail IDs
- at most one bounded current-turn compression-map execution skeleton (entry keys/kinds, physical
  message IDs, optional block anchors, protected flags, tool IDs, and approximate metrics needed
  to execute without rebuilding the transcript)
- per-session compression stats
- session automatic-compression overrides and the post-compression cooldown anchor

The execution skeleton is replaced on each successful `compress_map`, and cleared on successful
`compress`, a new management turn, a later visible user message, or native compaction/reset. It is
not a map-text cache, transcript copy, or snapshot history.

The raw conversation history still exists in OpenCode storage, but completed management machinery
is suppressed from future model prompts. Restarting the session reloads the saved cleanup markers,
so old management turns do not reappear in the model-visible stream.

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
