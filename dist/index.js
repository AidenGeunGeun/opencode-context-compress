import { getConfig } from "./lib/config.js";
import { Logger } from "./lib/logger.js";
import { SessionStateManager } from "./lib/state/index.js";
import { createCompressTool, createSquashTool } from "./lib/tools/index.js";
import { createChatMessageHandler, createChatMessageTransformHandler, createCommandExecuteHandler, } from "./lib/hooks.js";
import { configureClientAuth, isSecureMode } from "./lib/auth.js";
import { createAutomaticCompressionEventHandler, createChatParamsHandler, } from "./lib/auto-compression.js";
import { createReportNudgeEventHandler } from "./lib/report-nudge.js";
const stateManager = new SessionStateManager();
const plugin = (async (ctx) => {
    const config = getConfig(ctx);
    if (!config.enabled) {
        return {};
    }
    const logger = new Logger({ daily: config.dailyLog ?? config.debug, context: config.debug });
    if (isSecureMode()) {
        configureClientAuth(ctx.client);
    }
    logger.info("Context Compress initialized");
    const automaticCompressionEvent = createAutomaticCompressionEventHandler(ctx.client, stateManager, logger, config);
    const reportNudgeEvent = createReportNudgeEventHandler(ctx.client, stateManager, logger, config);
    const hooks = {
        // Compression runs first so a fault in the advisory nudge can never keep the session
        // from compressing.
        event: async (input) => {
            await automaticCompressionEvent(input);
            await reportNudgeEvent(input);
        },
        "experimental.chat.messages.transform": createChatMessageTransformHandler(ctx.client, stateManager, logger, ctx.directory),
        "chat.params": createChatParamsHandler(stateManager),
        "chat.message": createChatMessageHandler(stateManager, logger),
        "command.execute.before": createCommandExecuteHandler(ctx.client, stateManager, logger, config),
        tool: {
            ...(config.tools.compress.permission !== "deny" && {
                compress: createCompressTool({
                    client: ctx.client,
                    stateManager,
                    logger,
                    config,
                }),
                squash: createSquashTool({
                    client: ctx.client,
                    stateManager,
                    logger,
                    config,
                }),
            }),
        },
        config: async (opencodeConfig) => {
            if (config.autoCompression.enabled) {
                opencodeConfig.compaction = {
                    ...opencodeConfig.compaction,
                    auto: false,
                };
            }
            if (config.commands.enabled) {
                opencodeConfig.command ??= {};
                opencodeConfig.command["compress"] = {
                    template: "",
                    description: "Show available context compression commands",
                };
            }
            const toolsToAdd = [];
            if (config.tools.compress.permission !== "deny")
                toolsToAdd.push("compress", "squash");
            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? [];
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                };
                logger.info(`Added ${toolsToAdd.map((t) => `'${t}'`).join(" and ")} to experimental.primary_tools via config mutation`);
            }
            // Set tool permissions from plugin config
            const permission = opencodeConfig.permission ?? {};
            opencodeConfig.permission = {
                ...permission,
                compress: config.tools.compress.permission,
                squash: config.tools.compress.permission,
            };
        },
    };
    return hooks;
});
export default plugin;
//# sourceMappingURL=index.js.map