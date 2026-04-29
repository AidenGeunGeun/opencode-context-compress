import { getConfig } from "./lib/config";
import { Logger } from "./lib/logger";
import { SessionStateManager } from "./lib/state";
import { createCompressMapTool, createCompressTool } from "./lib/tools";
import { createChatMessageTransformHandler, createCommandExecuteHandler, createSessionForkHandler } from "./lib/hooks";
import { configureClientAuth, isSecureMode } from "./lib/auth";
const stateManager = new SessionStateManager();
const plugin = (async (ctx) => {
    const config = getConfig(ctx);
    if (!config.enabled) {
        return {};
    }
    const logger = new Logger(config.debug);
    if (isSecureMode()) {
        configureClientAuth(ctx.client);
        // logger.info("Secure mode detected, configured client authentication")
    }
    logger.info("Context Compress initialized");
    const hooks = {
        "experimental.chat.messages.transform": createChatMessageTransformHandler(ctx.client, stateManager, logger, config, ctx.directory),
        "chat.message": async (input, _output) => {
            // Cache variant from real user messages (not synthetic)
            // This avoids scanning all messages to find variant
            stateManager.get(input.sessionID).variant = input.variant;
            logger.debug("Cached variant from chat.message hook", { variant: input.variant });
        },
        "command.execute.before": createCommandExecuteHandler(ctx.client, stateManager, logger, config),
        "session.fork": createSessionForkHandler(stateManager, logger),
        tool: {
            ...(config.tools.compress_map.permission !== "deny" && {
                compress_map: createCompressMapTool({
                    client: ctx.client,
                    stateManager,
                    logger,
                    config,
                    workingDirectory: ctx.directory,
                }),
            }),
            ...(config.tools.compress.permission !== "deny" && {
                compress: createCompressTool({
                    client: ctx.client,
                    stateManager,
                    logger,
                    config,
                    workingDirectory: ctx.directory,
                }),
            }),
        },
        config: async (opencodeConfig) => {
            if (config.commands.enabled) {
                opencodeConfig.command ??= {};
                opencodeConfig.command["compress"] = {
                    template: "",
                    description: "Show available context compression commands",
                };
            }
            const toolsToAdd = [];
            if (config.tools.compress_map.permission !== "deny")
                toolsToAdd.push("compress_map");
            if (config.tools.compress.permission !== "deny")
                toolsToAdd.push("compress");
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
                compress_map: config.tools.compress_map.permission,
                compress: config.tools.compress.permission,
            };
        },
    };
    return hooks;
});
export default plugin;
//# sourceMappingURL=index.js.map