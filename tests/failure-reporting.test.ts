import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { WithParts } from "../lib/state/types.ts"
import { isolateHostDirs, modelRequest, startContextHook } from "./helpers.ts"

const root = await isolateHostDirs()
const { Logger } = await import("../lib/logger.ts")
const { setup } = await import("../lib/plugin.ts")
after(() => rm(root, { recursive: true, force: true }))

describe("unsynchronized session state", () => {
    it("reports that the model will see the untransformed transcript", async (t) => {
        const sessionId = "session-desync"
        const storage = join(root, "data", "opencode", "storage", "plugin", "compress")
        await mkdir(storage, { recursive: true })
        await writeFile(join(storage, `${sessionId}.json`), "{ not valid json", "utf-8")
        const error = t.mock.method(Logger.prototype, "error")
        const transcript: WithParts[] = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId, time: { created: 1 } },
                parts: [{ type: "text", text: "hello" }],
            },
        ]
        const context = await startContextHook(setup, root, { context: async () => transcript })
        const messages = modelRequest(transcript)

        await context(sessionId, messages)

        assert.equal(error.mock.callCount(), 1)
        const [message, data] = error.mock.calls[0].arguments
        assert.match(message, /untransformed transcript/)
        assert.equal(data?.sessionID, sessionId)
        assert.deepEqual(messages, modelRequest(transcript))
    })
})
