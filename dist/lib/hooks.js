import { syncToolCache } from "./state/tool-cache.js";
import { applyCompressTransforms } from "./messages/index.js";
import { buildToolIdList } from "./messages/utils.js";
import { checkSession } from "./state/index.js";
import { handleStatsCommand } from "./commands/stats.js";
import { handleContextCommand } from "./commands/context.js";
import { handleHelpCommand } from "./commands/help.js";
import { handleManageCommand } from "./commands/manage.js";
import { handleAutoCommand } from "./commands/auto.js";
import { suppressDefaultCommandExecution } from "./commands/suppress.js";
import { reconcileSessionLifecycle } from "./state/state.js";
import { listSessionMessages } from "./sdk/client.js";
import { isIgnoredUserMessage } from "./messages/utils.js";
export function getLastUserSessionId(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === "user") {
            return messages[i].info.sessionID;
        }
    }
    return undefined;
}
export function createChatMessageTransformHandler(client, stateManager, logger, config, workingDirectory) {
    return async (_input, output) => {
        const sessionId = getLastUserSessionId(output.messages);
        if (!sessionId)
            return;
        const state = stateManager.get(sessionId);
        const transformed = await stateManager.runExclusive(sessionId, async () => {
            const syncResult = await checkSession(client, state, logger, output.messages);
            if (state.isSubAgent)
                return false;
            if (!state.persistenceSynchronized)
                return false;
            const messageIds = new Set(output.messages.map((message) => message.info.id));
            const appliedCompressedMessageCount = Array.from(state.compressed.messageIds).filter((id) => messageIds.has(id)).length;
            const appliedSummaryCount = state.compressSummaries.filter((summary) => messageIds.has(summary.anchorMessageId)).length;
            logger.info("Resolved compress state for prompt transform", {
                sessionID: sessionId,
                directory: workingDirectory,
                source: syncResult.source,
                lastUpdated: syncResult.lastUpdated,
                compressedMessageCount: appliedCompressedMessageCount,
                summaryCount: appliedSummaryCount,
            });
            syncToolCache(state, config, logger, output.messages);
            buildToolIdList(state, output.messages);
            applyCompressTransforms(state, logger, output.messages);
            return true;
        });
        if (transformed) {
            await logger.saveContext(sessionId, output.messages);
        }
    };
}
export function createChatMessageHandler(stateManager, logger) {
    return async (input, output) => {
        const message = output?.message;
        const parts = Array.isArray(output?.parts) ? output.parts : [];
        const userMessage = message ? { info: message, parts } : undefined;
        if (userMessage && isIgnoredUserMessage(userMessage))
            return;
        const state = stateManager.get(input.sessionID);
        state.variant = input.variant;
        logger.debug("Cached variant from chat.message hook", { variant: input.variant });
    };
}
export function createCommandExecuteHandler(client, stateManager, logger, config) {
    return async (input, output) => {
        if (!config.commands.enabled) {
            return;
        }
        if (input.command === "compress") {
            const state = stateManager.get(input.sessionID);
            const messages = await stateManager.runExclusive(input.sessionID, async () => {
                const currentMessages = (await listSessionMessages(client, input.sessionID));
                await reconcileSessionLifecycle(client, state, input.sessionID, logger, currentMessages);
                return currentMessages;
            });
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
                suppressDefaultCommandExecution(output);
                return;
            }
            if (subcommand === "stats") {
                await handleStatsCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                });
                suppressDefaultCommandExecution(output);
                return;
            }
            if (subcommand === "manage") {
                await handleManageCommand({
                    client,
                    stateManager,
                    state,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                    arguments: input.arguments,
                });
                suppressDefaultCommandExecution(output);
                return;
            }
            if (subcommand === "auto") {
                await handleAutoCommand({
                    client,
                    stateManager,
                    state,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                    arguments: args.slice(1),
                });
                suppressDefaultCommandExecution(output);
                return;
            }
            await handleHelpCommand({
                client,
                state,
                logger,
                sessionId: input.sessionID,
                messages,
            });
            suppressDefaultCommandExecution(output);
        }
    };
}
//# sourceMappingURL=hooks.js.map