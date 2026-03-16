# opencode-context-compress - Project State

**Last Updated:** 2026-02-20
**Path:** `~/projects/agents/OCstuff/<plugin-directory>`
**Version:** 0.1.0
**Runtime:** Node.js + TypeScript

---

## Current Status

- Build: `npm run build`
- Tests: `npm test`
- Plugin entry: `dist/index.js`
- Primary config: `~/.config/opencode/compress.jsonc`

---

## Scope

This plugin is focused on manual context compression only.

- Triggered by `/compress manage`
- Uses `<compress-context-map>` for range selection
- Persists compression state under `plugin/compress/`

---

## Key Modules

| File | Purpose |
|---|---|
| `index.ts` | Plugin entry, config loading, hook registration |
| `lib/hooks.ts` | Message transforms and `/compress` command routing |
| `lib/tools/compress.ts` | Compression tool execution and state updates |
| `lib/messages/compress-transform.ts` | Applies compressed message/tool transforms |
| `lib/messages/context-map.ts` | Builds and resolves `<compress-context-map>` ranges |
| `lib/config.ts` | Config defaults, validation, and layered merge |
| `lib/state/persistence.ts` | Session persistence and aggregate stats loading |

---

## Operational Notes

- Submit all compression ranges in one tool call because each call rebuilds the context map.
- Compression metrics split block summary estimate and new-content estimate to avoid double counting.
- Notifications are controlled by `notification` and `notificationType` config keys.
- Debug logging path is `~/.config/opencode/logs/compress/`.
