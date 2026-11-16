import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import type { WithParts } from "../lib/state/types.ts"
import { fakeClient, isolateHostDirs, type SyntheticInput } from "./helpers.ts"

const root = await isolateHostDirs()
const { handleCompressCommand } = await import("../lib/commands/route.ts")
const { getConfig } = await import("../lib/config.ts")
const { Logger } = await import("../lib/logger.ts")
const { loadSessionState } = await import("../lib/state/persistence.ts")
const { SessionStateManager } = await import("../lib/state/state.ts")
after(() => rm(root, { recursive: true, force: true }))

const logger = new Logger({ daily: false, context: false })
const sessionId = "session-fold-command"
const messages: WithParts[] = [
    {
        info: {
            id: "u1",
            sessionID: sessionId,
            role: "user",
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-test" },
            time: { created: Date.now() },
        },
        parts: [{ type: "text", text: "Continue the task" }],
    },
]

/** A fresh state manager per harness, so a second harness reads what the first one persisted. */
function createHarness() {
    const feedback: SyntheticInput[] = []
    const client = fakeClient({
        context: async () => messages,
        synthetic: (input) => feedback.push(input),
    })
    const stateManager = new SessionStateManager()
    return async (arguments_: string) => {
        await handleCompressCommand(
            { command: "compress", sessionID: sessionId, arguments: arguments_ },
            { client, stateManager, logger, config: getConfig({ directory: root }) },
        )
        return feedback.at(-1)?.text ?? ""
    }
}

describe("/compress on|off", () => {
    it("persists fold requests off and on, and a fresh state manager reads it back", async () => {
        const run = createHarness()

        assert.match(await run("status"), /fold requests are on for this session/)
        assert.match(await run("on"), /already on/)
        assert.match(await run("off"), /off for this session/)
        assert.equal((await loadSessionState(sessionId, logger)).status, "loaded")
        const fresh = createHarness()
        assert.match(await fresh("status"), /fold requests are off/)
        assert.match(await fresh("on"), /fold requests are on for this session/)
        assert.match(await createHarness()("status"), /fold requests are on/)
    })
})
