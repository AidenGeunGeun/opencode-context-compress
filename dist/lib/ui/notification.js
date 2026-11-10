import { promptSession } from "../sdk/client.js";
export async function sendIgnoredMessage(client, sessionID, text, logger) {
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
        });
    }
    catch (error) {
        logger.error("Failed to send notification", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
//# sourceMappingURL=notification.js.map