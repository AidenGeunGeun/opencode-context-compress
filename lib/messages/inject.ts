import type { SessionState, WithParts } from "../state/index.js"
import type { Logger } from "../logger.js"
import { buildContextMap } from "./context-map.js"

export const buildCompressContext = (
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
    providerId?: string,
): string => {
    return buildContextMap(messages, state, logger, providerId).mapText
}
