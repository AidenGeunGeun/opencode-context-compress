import type { WithParts } from "../lib/state/index.js"
import { type SessionStateManager, checkSession } from "../lib/state/index.js"
import type { Logger } from "../lib/logger.js"
import {
    appendPostCompressionNotice,
    applyCompressTransforms,
    isPostCompressionNoticeDue,
} from "../lib/messages/index.js"
import { getLastUserMessage } from "../lib/shared-utils.js"

export function getLastUserSessionId(messages: WithParts[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].info.role === "user") return messages[index].info.sessionID
    }
}

export function createChatMessageTransformHandler(
    _client: unknown,
    stateManager: SessionStateManager,
    logger: Logger,
) {
    return async (_input: unknown, output: { messages: WithParts[] }) => {
        const sessionID = getLastUserSessionId(output.messages)
        if (!sessionID) return
        const noticeBaseMessage = getLastUserMessage(output.messages)
        const state = stateManager.get(sessionID)
        const transformed = await stateManager.runExclusive(sessionID, async () => {
            const syncResult = await checkSession(state, logger, output.messages)
            if (!state.persistenceSynchronized) {
                logger.error(
                    "Skipping compression for this turn: session state is not synchronized, so the model sees the untransformed transcript",
                    {
                        sessionID,
                        source: syncResult.source,
                    },
                )
                return false
            }
            const noticeDue = isPostCompressionNoticeDue(state, output.messages)
            applyCompressTransforms(state, logger, output.messages)
            if (noticeDue && noticeBaseMessage)
                appendPostCompressionNotice(output.messages, noticeBaseMessage)
            return true
        })
        if (transformed) await logger.saveContext(sessionID, output.messages)
    }
}
