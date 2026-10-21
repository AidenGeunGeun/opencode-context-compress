import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { after, it } from "node:test"

import {
    fakeSession,
    hostContext,
    isolateHostDirs,
    type SyntheticInput,
    sessionInfo,
} from "./helpers.ts"

const root = await isolateHostDirs()
const { generateNativeCompactionNoticeId } = await import("../lib/commands/manage.ts")
const { setup } = await import("../lib/plugin.ts")
after(() => rm(root, { recursive: true, force: true }))

const compactionStarted = (sessionID: string, reason: string, directory = root) => ({
    id: `evt-${sessionID}`,
    created: 1_000,
    type: "session.compaction.started",
    data: { sessionID, reason },
    location: { directory },
})

it("warns the owning session about native auto-compaction but not a manual reset", async () => {
    const synthetic: SyntheticInput[] = []
    const registration = { dispose: async () => undefined }
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
})

it("derives a well-formed message ID unique to the compaction event", () => {
    const event = compactionStarted("owned", "auto")
    const id = generateNativeCompactionNoticeId("owned", event)
    assert.match(id ?? "", /^msg_[0-9a-f]{26}$/)
    assert.notEqual(generateNativeCompactionNoticeId("owned", { ...event, id: "evt-other" }), id)
    assert.match(
        generateNativeCompactionNoticeId("owned", { ...event, created: 1_000.5 }) ?? "",
        /^msg_[0-9a-f]{26}$/,
    )
})
