# Script Utilities

This directory contains local developer utilities used for prompt debugging and generation.

## Prompt Preview CLI (`npm run compress`)

`scripts/print.ts` renders current prompt/template output for quick validation.

Run with:

```bash
npm run compress -- [flags]
```

Supported flag:

- `--system`: render the compression management prompt.

Examples:

```bash
npm run compress -- --system
```

## Prompt Codegen

`npm run generate:prompts` converts markdown prompt files in `lib/prompts/` into generated TypeScript files under `lib/prompts/_codegen/`.

Current generated prompt set:

- `system.generated.ts`
- `compress.generated.ts`
- `automatic-system.generated.ts`
