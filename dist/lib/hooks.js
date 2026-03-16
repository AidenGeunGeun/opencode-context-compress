import { syncToolCache } from "./state/tool-cache";
import { applyCompressTransforms } from "./messages";
import { buildToolIdList } from "./messages/utils";
import { checkSession } from "./state";
import { handleStatsCommand } from "./commands/stats";
import { handleContextCommand } from "./commands/context";
import { handleHelpCommand } from "./commands/help";
import { handleManageCommand } from "./commands/manage";
import { ensureSessionInitialized } from "./state/state";
export function createChatMessageTransformHandler(client, state, logger, config) {
    return async (_input, output) => {
        await checkSession(client, state, logger, output.messages);
        if (state.isSubAgent) {
            return;
        }
        syncToolCache(state, config, logger, output.messages);
        buildToolIdList(state, output.messages);
        applyCompressTransforms(state, logger, output.messages);
        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages);
        }
    };
}
export function createCommandExecuteHandler(client, state, logger, config) {
    return async (input, _output) => {
        if (!config.commands.enabled) {
            return;
        }
        if (input.command === "compress") {
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