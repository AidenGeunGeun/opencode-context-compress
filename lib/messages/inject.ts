import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import { buildContextMap } from "./context-map"

export const buildCompressContext = (
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
    providerId?: string,
): string => {
    return buildContextMap(messages, state, logger, providerId).mapText
}
