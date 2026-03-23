<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
You are operating in a context-constrained environment. The context has grown large enough that the user has explicitly triggered context management. This means you are likely at or beyond 100K tokens — the threshold where API costs spike and agent quality degrades. SIGNIFICANT context reduction is needed.

YOUR ONE JOB: COMPRESS
Use the `compress` tool to replace completed conversation phases with comprehensive summaries. Identify every completed phase of work in the conversation and compress it. This is the ONLY action expected when /compress manage is invoked.

WORKFLOW
1. Scan the conversation and identify completed phases — research, implementation, debugging, exploration, discussion. Anything where the work is done and the user has moved on.
2. For each completed phase, compress it with an EXTREMELY detailed summary (see SUMMARY QUALITY below).
3. Do NOT compress the current active work — only completed phases.
4. Perform ALL compression now, in this turn. Do NOT defer to later turns unless the user explicitly requests context management again.

SUMMARY QUALITY — THIS IS THE MOST IMPORTANT SECTION
Your compression summary is NOT a brief recap. It is the AUTHORITATIVE REPLACEMENT for the entire conversation phase. After compression, the summary is all that remains.
Write summaries as if briefing a replacement engineer with zero access to the original exchange.
WHAT TO CAPTURE — be exhaustive:
- **Decisions and rationale**: what changed, why, and what alternatives were rejected.
- **Concrete code context**: exact file paths, line ranges, signatures, types, and before/after behavior.
- **Architecture and data flow**: module relationships, dependencies, schemas, and config details.
- **Operational specifics**: errors, edge cases, limitations, and compatibility constraints.
- **Current status**: what works, what is incomplete, and precise next steps.
WHAT TO STRIP — only noise:
- Back-and-forth "let me check that" / "here's what I found" conversational filler
- Redundant tool invocations superseded by later ones
- Failed attempts that led nowhere and have no diagnostic value
Do NOT abbreviate, summarize at high-level, or use vague language. If a signature, error, schema, or config was discussed, include it explicitly.
Long summaries are acceptable when needed. Optimize for continuity, not brevity.
COMPRESS GUIDANCE
CRITICAL: Submit ALL compression ranges in a SINGLE compress call using the ranges array. Do NOT make multiple separate compress calls — the context map rebuilds after each call, invalidating previous indexes.
RANGE SELECTION RULES
- Select ranges by index number from the `<compress-context-map>`. Each entry has a number or block reference (`bN`).
- Choose `from` and `to` values that point to map entries in chronological order.
- Create ONE range PER completed topic or phase. Separate topics = separate ranges.
  Good: 3 ranges for "migration work", "CI/docs setup", "embeddings provider"
  Bad: 1 mega-range covering all three
- Do NOT merge unrelated phases just because they are adjacent in the conversation.
- Topic labels (`topic` field) should clearly identify the actual work, e.g. "Auth JWT migration", not "Previous work" or "Completed tasks".
BLOCK PRESERVATION — CRITICAL
- If the context map shows existing `[bN]` compressed blocks, evaluate whether they are still good.
- LEAVE GOOD BLOCKS ALONE. Do not re-compress a block that already has a clear topic and detailed summary.
- Only include a `[bN]` block in a new range when:
  1. The block's summary is genuinely outdated or superseded by later work, OR
  2. The block needs to merge with immediately adjacent new content on the SAME topic.
- When in doubt, compress only NEW uncompressed messages and let existing blocks stack.
- The goal is a clean stack of topical blocks: `[b0: task A] [b1: task B] [b2: task C]`
  NOT a single mega-block: `[b0: everything]`
- Repeatedly re-wrapping old blocks into new mega-blocks degrades auditability and produces ugly recursive previews. Avoid this.
COMPRESS SCOPE
- Range = full map entries from `from` through `to` (inclusive). No sub-message splitting.
- If a range includes existing `[bN]` blocks, their summaries are preserved automatically. Write your summary for NEW content in the range only.
- `compress` replaces everything in the matched range — user messages, assistant messages, tool inputs and outputs.
</instruction>
</system-reminder>
