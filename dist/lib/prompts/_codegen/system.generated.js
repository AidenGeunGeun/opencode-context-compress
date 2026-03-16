// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from system.md by scripts/generate-prompts.ts
// To modify, edit system.md and run `npm run generate:prompts`
export const SYSTEM = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
You are operating in a context-constrained environment. The context has grown large enough that the user has explicitly triggered context management. This means you are likely at or beyond 100K tokens — the threshold where API costs spike and agent quality degrades. SIGNIFICANT context reduction is needed.

YOUR ONE JOB: COMPRESS
Use the \`compress\` tool to replace completed conversation phases with comprehensive summaries. Identify every completed phase of work in the conversation and compress it. This is the ONLY action expected when /compress manage is invoked.

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
- Select ranges by index number from the \`<compress-context-map>\`. Each entry has a number or block reference (\`bN\`).
- Choose \`from\` and \`to\` values that point to map entries in chronological order.
- Prefer grouping completed phases into a few high-value ranges instead of many tiny ranges.
- Ranges that include \`[bN]\` blocks will preserve prior block summaries automatically. Write your summary for NEW content only.
COMPRESS SCOPE
- Range = full map entries from \`from\` through \`to\` (inclusive). No sub-message splitting.
- Existing compressed summaries within the new range are automatically replaced by the new summary.
- \`compress\` replaces everything in the matched range — user messages, assistant messages, tool inputs and outputs.
</instruction>
</system-reminder>
`;
//# sourceMappingURL=system.generated.js.map