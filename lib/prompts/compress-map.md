Use this tool during a user-initiated `/compress manage` turn to fetch the current compression map.

The result is a compact `<compress-context-map>` snapshot with numeric entries, `[bN]` blocks, previews, per-entry token estimates, and a totals footer.

Use it at the start of context management or any time you want a fresh snapshot. After a `compress` call, prefer the refreshed map returned by that tool as the next source of truth. The map does not mark an active tail for you; decide what to leave uncompressed from the conversation itself.

Do not use this tool outside explicit user-requested context management.
