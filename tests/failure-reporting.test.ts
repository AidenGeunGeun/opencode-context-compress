import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { createChatMessageTransformHandler } from "./transform-harness.ts"
import { Logger } from "../lib/logger.ts"
import { SessionStateManager } from "../lib/state/state.ts"
import type { WithParts } from "../lib/state/types.ts"

function createSpyLogger() {
    const logger = new Logger({ daily: false, context: false })
    const errors: Array<{ message: string; data?: Record<string, unknown> }> = []
    logger.error = async (message: string, data?: Record<string, unknown>) => {
        errors.push({ message, data })
    }
    return { logger, errors }
}

const sessionFilePath = (sessionId: string) =>
    join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "compress",
        `${sessionId}.json`,
    )

describe("unsynchronized session state", () => {
    it("reports that the model will see the untransformed transcript", async () => {
        const sessionId = `session-desync-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const filePath = sessionFilePath(sessionId)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, "{ not valid json", "utf-8")

        try {
            const { logger, errors } = createSpyLogger()
            const handler = createChatMessageTransformHandler(
                { session: { get: async () => ({ data: {} }) } },
                new SessionStateManager(),
                logger,
            )
            const output: { messages: WithParts[] } = {
                messages: [
                    {
                        info: {
                            id: "m1",
                            role: "user",
                            sessionID: sessionId,
                            time: { created: Date.now() },
                        },
                        parts: [{ type: "text", text: "hello" }],
                    },
                ],
            }

            await handler({}, output)

            assert.equal(errors.length, 1)
            assert.match(errors[0].message, /untransformed transcript/)
            assert.equal(errors[0].data?.sessionID, sessionId)
            assert.deepEqual(
                output.messages.map((message) => message.info.id),
                ["m1"],
            )
        } finally {
            if (existsSync(filePath)) await rm(filePath)
        }
    })
})
