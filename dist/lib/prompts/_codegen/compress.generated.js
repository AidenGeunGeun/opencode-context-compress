// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from compress.md by scripts/generate-prompts.ts
// To modify, edit compress.md and run `npm run generate:prompts`
export const COMPRESS = `Use this tool to collapse a contiguous range of conversation into a preserved summary.

AUTHORIZATION
MUST NOT use compress unless the user explicitly requests it (e.g., \`/compress manage\`, "compress this", "clean up context").
Never invoke compress autonomously or proactively. Context management is a user-initiated action.

THE PHILOSOPHY OF COMPRESS
\`compress\` transforms verbose conversation sequences into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

THE WAYS OF COMPRESS
\`compress\` when a chapter closes - when a phase of work is truly complete and the raw conversation has served its purpose:

Research concluded and findings are clear
Implementation finished and verified
Exploration exhausted and patterns understood

Do NOT compress when:
You may need exact code, error messages, or file contents from the range
Work in that area is still active or may resume
You're mid-sprint on related functionality

Before compressing, ask: _"Is this chapter closed?"_ Compression is irreversible. The summary replaces everything in the range.

BLOCK LIFECYCLE — STACKING OVER REWRAPPING
The compression system maintains a stack of compressed blocks (\`[b0]\`, \`[b1]\`, etc.). Each block should represent a single coherent topic or phase.
- Prefer creating NEW blocks alongside existing ones rather than rewrapping old blocks into a mega-block.
- Existing blocks with clear, detailed summaries should be LEFT ALONE.
- Only include an existing \`[bN]\` block in a new range if its content is directly superseded or needs merging with adjacent same-topic work.
- The topic label should identify the actual content — "Auth JWT migration", not "previous work".
- Good result: \`[b0: migration] [b1: CI setup] [b2: embeddings]\` — each block is auditable and topical.
- Bad result: \`[b0: everything from the whole session]\` — lost structure, hard to audit.

THE FORMAT OF COMPRESS
\`ranges\`: Array of objects with:
\`from\`: Index number from \`<compress-context-map>\`, or block reference like \`"b1"\`
\`to\`: Index number from \`<compress-context-map>\`, or block reference like \`"b1"\`
\`summary\`: Complete technical summary for NEW content in this range
\`topic\`: Short label (3-5 words) for display - e.g., "Auth System Exploration"

IMPORTANT: Submit ALL compression ranges in a SINGLE compress call using the ranges array. Do NOT make multiple separate compress calls — the context map rebuilds after each call, invalidating previous indexes.
`;
//# sourceMappingURL=compress.generated.js.map