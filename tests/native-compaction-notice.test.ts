import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"

import { setup } from "../lib/plugin.ts"

it("warns the owning session about native auto-compaction but not a manual reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-compress-native-"))
    const previousConfig = process.env.XDG_CONFIG_HOME
    const previousData = process.env.XDG_DATA_HOME
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_DATA_HOME = join(root, "data")
    await mkdir(join(root, "config", "opencode"), { recursive: true })
    const synthetic: any[] = []
    const registration = { dispose: async () => undefined }
    const compactionStarted = (sessionID: string, reason: string, directory = root) =>
        ({ type: "session.compaction.started", data: { sessionID, reason }, location: { directory } })
    let processed!: () => void
    const allProcessed = new Promise<void>((resolve) => { processed = resolve })
    const events = {
        async *[Symbol.asyncIterator]() {
            yield compactionStarted("elsewhere", "auto", join(root, "other"))
            yield compactionStarted("manual-reset", "manual")
            yield compactionStarted("owned", "auto")
            processed()
        },
    }

    try {
        const cleanup = await setup({
            location: { directory: root },
            command: { transform: async () => registration },
            tool: { transform: async () => registration },
            session: {
                context: async () => [],
                synthetic: async (input: any) => void synthetic.push(input),
                prompt: async () => undefined,
                get: async () => ({ location: { directory: root } }),
                hook: async () => registration,
            },
            model: { list: async () => ({ data: [] }) },
            event: { subscribe: () => events },
        } as any)
        await allProcessed
        await cleanup()

        assert.deepEqual(synthetic.map((input) => input.sessionID), ["owned"])
        assert.match(synthetic[0].text, /"compaction": \{ "auto": false \}/)
        assert.equal(synthetic[0].resume, false)
    } finally {
        if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousConfig
        if (previousData === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousData
        await rm(root, { recursive: true, force: true })
    }
})
