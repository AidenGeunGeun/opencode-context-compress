import { syncToolCache } from "./state/tool-cache";
import { applyCompressTransforms } from "./messages";
import { buildToolIdList } from "./messages/utils";
import { checkSession } from "./state";
import { handleStatsCommand } from "./commands/stats";
import { handleContextCommand } from "./commands/context";
import { handleHelpCommand } from "./commands/help";
import { handleManageCommand } from "./commands/manage";
import { ensureSessionInitialized } from "./state/state";
export function getLastUserSessionId(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === "user") {
            return messages[i].info.sessionID;
        }
    }
    return undefined;
}
export function createChatMessageTransformHandler(client, stateManager, logger, config) {
    return async (_input, output) => {
        const sessionId = getLastUserSessionId(output.messages);
        const msgCount = output.messages.length;
        const callerInfo = new Error().stack?.split("\n")[2]?.trim() || "unknown";
        logger.info(`[DIAG:transform] ENTER | sessionId=${sessionId} | msgCount=${msgCount} | activeSessions=${stateManager.size()} | caller=${callerInfo}`);
        if (!sessionId) {
            logger.info("[DIAG:transform] EXIT early — no sessionId found in messages");
            return;
        }
        const isNew = !stateManager.has(sessionId);
        const state = stateManager.get(sessionId);
        logger.info(`[DIAG:transform] state lookup | sessionId=${sessionId} | isNewState=${isNew} | initialized=${state.initialized} | isSubAgent=${state.isSubAgent} | compressedMsgIds=${state.compressed.messageIds.size} | compressedToolIds=${state.compressed.toolIds.size} | summaries=${state.compressSummaries.length}`);
        await checkSession(client, state, logger, output.messages);
        logger.info(`[DIAG:transform] post-checkSession | initialized=${state.initialized} | isSubAgent=${state.isSubAgent} | compressedMsgIds=${state.compressed.messageIds.size} | compressedToolIds=${state.compressed.toolIds.size} | summaries=${state.compressSummaries.length}`);
        if (state.isSubAgent) {
            logger.info("[DIAG:transform] EXIT early — isSubAgent=true");
            return;
        }
        syncToolCache(state, config, logger, output.messages);
        buildToolIdList(state, output.messages);
        const msgCountBefore = output.messages.length;
        applyCompressTransforms(state, logger, output.messages);
        const msgCountAfter = output.messages.length;
        logger.info(`[DIAG:transform] post-compress | msgsBefore=${msgCountBefore} | msgsAfter=${msgCountAfter} | removed=${msgCountBefore - msgCountAfter}`);
        await logger.saveContext(sessionId, output.messages);
        logger.info("[DIAG:transform] EXIT normal");
    };
}
export function createCommandExecuteHandler(client, stateManager, logger, config) {
    return async (input, _output) => {
        if (!config.commands.enabled) {
            return;
        }
        if (input.command === "compress") {
            const state = stateManager.get(input.sessionID);
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            });
            const messages = (messagesResponse.data || messagesResponse);
            await ensureSessionInitialized(client, state, input.sessionID, logger, messages);
            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean);
            const subcommand = args[0]?.toLowerCase() || "";
            if (subcommand === "context") {
                await handleContextCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                });
                throw new Error("__COMPRESS_CONTEXT_HANDLED__");
            }
            if (subcommand === "stats") {
                await handleStatsCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                });
                throw new Error("__COMPRESS_STATS_HANDLED__");
            }
            if (subcommand === "manage") {
                await handleManageCommand({
                    client,
                    state,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                });
                throw new Error("__COMPRESS_MANAGE_HANDLED__");
            }
            await handleHelpCommand({
                client,
                state,
                logger,
                sessionId: input.sessionID,
                messages,
            });
            throw new Error("__COMPRESS_HELP_HANDLED__");
        }
    };
}
//# sourceMappingURL=hooks.js.map