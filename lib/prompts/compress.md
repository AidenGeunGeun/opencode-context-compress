Do not call this tool autonomously. Tool availability alone is not authorization. Call it only when the current turn contains either a manual/plugin-initiated compression-management reminder or an explicit user request in the current message to compress context.

Review the current conversation, then call this tool once with:
- `summary`: A truthful durable replacement for all eligible uncompressed history after the newest existing block. Preserve the objective and WHY, controlling spec or task contract, chronology, decisions, constraints, edits and paths, load-bearing commands and results, failures, fixes, re-validation, completed/pending/blocked work, latest disposition, any delivered final response or handoff, explicit unknowns, and a real next action only when one exists. Later evidence supersedes stale plans or pending lists; never invent missing facts or completion.
- `topic`: A short title for the new compressed block.

The plugin excludes existing compressed blocks and preserves the newest configured execution steps verbatim. Those later steps remain visible after the fold and may correct or supersede the summary.

A success receipt means the save is durable and the fold is already active. Do not call `compress` again that turn. After automatic compression, resume only when the latest evidenced disposition is genuinely active; do not reopen completed work or duplicate a final response.

A failure means nothing changed. Surface the exact diagnostic and do not retry unless the user gives new authorization.
