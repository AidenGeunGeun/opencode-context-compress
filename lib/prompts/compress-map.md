Use this tool as a fallback during a user-initiated `/compress manage` turn to fetch the current compression map. The current `<compress-context-map>` snapshot is normally already provided with the manage reminder, so this tool is not needed in the ordinary path.

The result is a compact `<compress-context-map>` snapshot with numeric entries, `[bN]` blocks, previews, per-entry token estimates, and a totals footer.

Call it only if the provided map is missing, looks stale, you need to inspect it explicitly, or an exceptional/debug case requires a fresh snapshot. It does not mark an active tail for you; decide what to leave uncompressed from the conversation itself.

This turn: by default, produce exactly one new block from the completed working context, appended as the newest `[bN]`, and leave existing `[bN]` blocks untouched. Only reselect existing `[bN]` blocks if the user explicitly asked you to consolidate older blocks.

Do not use this tool outside explicit user-requested context management.
