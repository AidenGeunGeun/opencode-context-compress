import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { watch } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { WithParts } from "../lib/state/types.ts"
import { isolateHostDirs, modelRequest, startContextHook } from "./helpers.ts"

const root = await isolateHostDirs()
await mkdir(join(root, "config", "opencode"), { recursive: true })
await writeFile(
    join(root, "config", "opencode", "compress.json"),
    JSON.stringify({ dailyLog: true }),
)
const { setup } = await import("../lib/plugin.ts")
after(() => rm(root, { recursive: true, force: true }))

describe("unsynchronized session state", () => {
    it("reports that the model will see the untransformed transcript", {
        timeout: 3_000,
    }, async (t) => {
        const sessionId = "session-desync"
        const storage = join(root, "data", "opencode", "storage", "plugin", "compress")
        await mkdir(storage, { recursive: true })
        await writeFile(join(storage, `${sessionId}.json`), "{ not valid json", "utf-8")
        const transcript: WithParts[] = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId, time: { created: 1 } },
                parts: [{ type: "text", text: "hello" }],
            },
        ]
        const context = await startContextHook(setup, root, { context: async () => transcript })
        const messages = modelRequest(transcript)

        const daily = join(root, "config", "opencode", "logs", "compress", "daily")
        const logPath = join(daily, `${new Date().toISOString().slice(0, 10)}.log`)
        await mkdir(daily, { recursive: true })
        const written = new Promise<string>((resolve, reject) => {
            const watcher = watch(daily, () => {
                void readFile(logPath, "utf-8").then((log) => {
                    if (log.includes("untransformed transcript")) resolve(log)
                }, reject)
            })
            t.after(() => watcher.close())
        })
        await context(sessionId, messages)
        const log = await written
        assert.match(log, /ERROR[^\n]*untransformed transcript[^\n]*sessionID=session-desync/)
        assert.deepEqual(messages, [
            { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
        ])
    })
})
