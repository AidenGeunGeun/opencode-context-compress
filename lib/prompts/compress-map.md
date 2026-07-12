Use this tool only during a current manual or plugin-initiated automatic compression-management turn. The user or plugin must open that turn; the model cannot create compression authority itself.

Call `compress_map` before `compress`. It returns a compact `<compress-context-map>` whose numeric entries are uncompressed messages, grouped numeric labels are inclusive contiguous display ranges, `[bN]` labels are existing compressed blocks, and `[protected active tail]` entries are unavailable to automatic compression.

The successfully returned map is atomically pinned as this turn's sole execution source of truth. A later successful call replaces that one pin; no history accumulates. Reasoning and other tool calls may occur before `compress` without changing the pin.

Choose the oldest completed uncompressed span and leave current work visible. Default append-only: leave `[bN]` blocks untouched unless the user explicitly requested consolidation.

If this call fails, no new map became authoritative. Read the diagnostic rather than guessing. The last successfully returned map from this same active turn, if any, remains pinned.
