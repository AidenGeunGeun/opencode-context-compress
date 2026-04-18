#!/usr/bin/env npx tsx

import { renderSystemPrompt, type ToolFlags } from "../lib/prompts/index.js"

const args = process.argv.slice(2)

const flags: ToolFlags = {
    compress: args.includes("-c") || args.includes("--compress"),
    compress_map: args.includes("-m") || args.includes("--compress-map"),
}

if (!flags.compress) {
    flags.compress = true
}

if (!flags.compress_map) {
    flags.compress_map = true
}

const showSystem = args.includes("--system")
const showCompressContext = args.includes("--compress-context")
const showHelp = args.includes("--help") || args.includes("-h")

if (showHelp || (!showSystem && !showCompressContext)) {
    console.log(`
Usage: npm run compress -- [TYPE] [FLAGS]

Types:
  --system            System prompt
  --compress-context  Example compress context map

Flags (for --system):
  -c, --compress      Enable compress tool guidance (default: on)
  -m, --compress-map  Enable compress_map tool guidance (default: on)

Examples:
  npm run compress -- --system
  npm run compress -- --compress-context
`)
    process.exit(0)
}

const header = (title: string) => {
    console.log()
    console.log("-".repeat(60))
    console.log(title)
    console.log("-".repeat(60))
}

if (showSystem) {
    header("SYSTEM PROMPT (tools: compress_map, compress)")
    console.log(renderSystemPrompt(flags))
}

if (showCompressContext) {
    header("COMPRESS CONTEXT MAP (mock example)")
    console.log(`<compress-context-map>
[1] user: "Let's implement JWT auth"
[2-4] assistant: 5 tool calls (read, glob, bash) - auth exploration (~1,240 tokens)
[b0] [compressed] "Prior database migration debugging" (~420 tokens)
[5] user: "Looks good, now add tests"
[6-8] assistant: 4 tool calls (edit, write, bash) - test implementation (~2,180 tokens)
---
Total: 8 messages + 1 block | ~6,500 tokens
</compress-context-map>`)
}
