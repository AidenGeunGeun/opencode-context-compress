#!/usr/bin/env npx tsx

import { renderSystemPrompt } from "../lib/prompts/index.js"

const args = process.argv.slice(2)

const showSystem = args.includes("--system")
const showHelp = args.includes("--help") || args.includes("-h")

if (showHelp || !showSystem) {
    console.log(`
Usage: npm run compress -- [TYPE] [FLAGS]

Types:
  --system            System prompt

Examples:
  npm run compress -- --system
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
    header("SYSTEM PROMPT")
    console.log(renderSystemPrompt())
}
