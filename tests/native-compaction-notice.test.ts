import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"

import { generateNativeCompactionNoticeId } from "../lib/commands/manage.ts"
import { setup } from "../lib/plugin.ts"
import { fakeSession, hostContext, type SyntheticInput, sessionInfo } from "./helpers.ts"

it("warns the owning session about native auto-compaction but not a manual reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-compress-native-"))
    const previousConfig = process.env.XDG_CONFIG_HOME
    const previousData = process.env.XDG_DATA_HOME
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_DATA_HOME = join(root, "data")
    await mkdir(join(root, "config", "opencode"), { recursive: true })
    const synthetic: SyntheticInput[] = []
    const registration = { dispose: async () => undefined }
    const compactionStarted = (sessionID: string, reason: string, directory = root) => ({
        id: `evt-${sessionID}`,
        created: 1_000,
        type: "session.compaction.started",
        data: { sessionID, reason },
        location: { directory },
    })
    const ownedEvent = compactionStarted("owned", "auto")
    let processed!: () => void
    const allProcessed = new Promise<void>((resolve) => {
        processed = resolve
    })
    const events = {
        async *[Symbol.asyncIterator]() {
            yield compactionStarted("elsewhere", "auto", join(root, "other"))
            yield compactionStarted("manual-reset", "manual")
            yield ownedEvent
            processed()
        },
    }

    try {
        const cleanup = await setup(
            hostContext({
                location: { directory: root },
                command: { transform: async () => registration },
                tool: { transform: async () => registration },
                session: {
                    ...fakeSession({ synthetic: (input) => synthetic.push(input) }),
                    get: async () => sessionInfo({ location: { directory: root } }),
                    hook: async () => registration,
                },
                model: { list: async () => ({ data: [] }) },
                event: { subscribe: () => events },
            }),
        )
        await allProcessed
        await cleanup()

        assert.deepEqual(
            synthetic.map((input) => input.sessionID),
            ["owned"],
        )
        assert.match(synthetic[0].text, /"compaction": \{ "auto": false \}/)
        assert.equal(synthetic[0].resume, false)
        // Every plugin instance derives the same ID, so the host admits the notice once.
        assert.equal(synthetic[0].id, generateNativeCompactionNoticeId("owned", ownedEvent))
    } finally {
        if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousConfig
        if (previousData === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousData
        await rm(root, { recursive: true, force: true })
    }
})
