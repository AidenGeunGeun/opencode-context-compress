Do not call this tool autonomously. Tool availability alone is not authorization. Call it only inside the still-active management turn created by the current user's `/compress squash` command; runtime authorization fails closed otherwise.

During that authorized turn, call this tool exactly once with four required non-empty values:
- `from`: The inclusive first current positional block label, such as `b1`.
- `to`: The inclusive last current positional block label, such as `b12`.
- `summary`: A truthful replacement for only that selected block range.
- `topic`: A short replacement block title.

Choose exactly one contiguous inclusive range containing at least two existing compressed blocks. Both endpoints are yours to choose unless the user's `<user-message>` gives more specific guidance. `[bN]` labels are current positions, not stable durable identities.

Squash touches only existing compressed blocks. All uncompressed conversation and out-of-range blocks remain unchanged. The replacement occupies the selected range's first position; later blocks preserve their relative order and receive new positional labels.

This is additional lossy compression of summaries: the hidden original messages are unavailable. Preserve chronology, objectives, decisions, constraints, established outcomes, the unresolved state at the selected range's end, and necessary evidence. Never reorder events, combine noncontiguous periods, or move later out-of-range evidence backward. Prefer a materially verbose or redundant range while leaving independently valuable blocks intact.

A success receipt means the replacement is durable and already active. Do not call squash or compress again that turn. A failure means nothing changed; surface the exact diagnostic and do not retry without new user authorization.
