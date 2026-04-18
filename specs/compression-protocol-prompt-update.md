# Spec: encode compression protocol into plugin prompts

## Intent

Bake the `/compress manage` workflow into the plugin's injected system prompt and the `compress` / `compress_map` tool descriptions. Any agent running `/compress manage` should follow the same protocol without the user coaching it every turn.

Each `compress` call rewrites message history and invalidates prompt cache from that point forward in the turn. Fewer calls per turn = cheaper turns. That's the whole reason the protocol exists.

## Protocol to encode

**Per compression turn:**
- Max 3 blocks. 2 is the default target. 3 only if the new conversation truly has distinct phases.
- Older blocks → terser. Newer blocks → more fidelity. Active tail → untouched.

**Layered pattern (compression N, for N ≥ 2):**
1. Dense archive blocks from compressions ≤ N−2: leave alone.
2. Blocks from compression N−1: fold into one dense block.
3. Newly-completed conversation since N−1: compress into 1–2 new blocks (3 max).

**Compression 1:** no archive yet; just compress completed conversation into 1–3 new blocks (2 preferred).

**One range per `compress` call** (already encoded, keep). `compress` returns the fresh map, so the agent does not need to call `compress_map` between `compress` calls.

## Scope

Prompt text only. Edit:
- `lib/prompts/system.md`
- `lib/prompts/compress.md`
- `lib/prompts/compress-map.md`

Regenerate `lib/prompts/_codegen/*.generated.ts` via `scripts/generate-prompts.ts`. Rebuild `dist/`.

Out of scope: tool logic, state, transforms, hooks, caching, block-numbering.

## Context

- Injected system reminder must still start with the anchor line `CONTEXT MANAGEMENT REQUESTED` (a test pins its presence).
- Conditional tags `<compress>…</compress>` and `<compress_map>…</compress_map>` in `system.md` must still work.
- `compress` already returns the fresh context map in its response — don't tell the agent to call `compress_map` between `compress` calls.
- Block IDs (`bN`) are stable across compressions (v2 fix), so "leave old dense blocks alone" is safe.

## Acceptance Criteria

1. `system.md` states: max 3 blocks per turn, 2 preferred; density-by-age; the three-generation layered fold pattern; one-line cost rationale (each `compress` call invalidates cache from that point).
2. `compress.md` reflects the same rules from the tool's usage POV — concise, not a restatement of the system reminder.
3. `compress-map.md` stays short. Optional one-liner pointing at the protocol.
4. No file is padded or verbose. Agent-directive voice, terse.
5. `CONTEXT MANAGEMENT REQUESTED` still begins the system reminder. Conditional tag expansion still works.
6. `scripts/generate-prompts.ts` regenerates codegen cleanly. `dist/` rebuilds cleanly.
7. `bun test` passes. If any test pins phrasing that changed, update the test — do not weaken behavioral assertions.
8. Zero runtime behavior changes.

## Verification

- Read the three markdown files after edits. Each answers "what do I do this turn?" in clear directive voice.
- Regenerate prompts, check one generated file, confirm conditional expansion works for both tool-flag combinations.
- `bun test` green. `dist/` rebuilt.

## Completion Standard

Three prompt files updated; codegen regenerated; tests green; `dist/` rebuilt. Protocol is explicit in the system reminder and echoed in `compress.md`. No runtime changes. No new files.
