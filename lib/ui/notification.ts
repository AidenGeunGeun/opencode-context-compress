import type { Logger } from "../logger.js"
import { type PluginClient, promptSession } from "../sdk/client.js"

export async function sendIgnoredMessage(
    client: PluginClient,
    sessionID: string,
    text: string,
    logger: Logger,
): Promise<void> {
    try {
        await promptSession(client, {
            sessionId: sessionID,
            noReply: true,
            parts: [
                {
                    type: "text",
                    text: text,
                    ignored: true,
                },
            ],
        })
    } catch (error) {
        logger.error("Failed to send notification", {
            error: error instanceof Error ? error.message : String(error),
        })
    }
}
