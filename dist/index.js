import { getConfig } from "./lib/config";
import { Logger } from "./lib/logger";
import { createSessionState } from "./lib/state";
import { createCompressTool } from "./lib/tools";
import { createChatMessageTransformHandler, createCommandExecuteHandler } from "./lib/hooks";
import { configureClientAuth, isSecureMode } from "./lib/auth";
const plugin = (async (ctx) => {
    const config = getConfig(ctx);
    if (!config.enabled) {
        return {};
    }
    const logger = new Logger(config.debug);
    const state = createSessionState();
    if (isSecureMode()) {
        configureClientAuth(ctx.client);
        // logger.info("Secure mode detected, configured client authentication")
    }
    logger.info("Context Compress initialized");
    return {
        "experimental.chat.messages.transform": createChatMessageTransformHandler(ctx.client, state, logger, config),
        "chat.message": async (input, _output) => {
            // Cache variant from real user messages (not synthetic)
            // This avoids scanning all messages to find variant
            state.variant = input.variant;
            logger.debug("Cached variant from chat.message hook", { variant: input.variant });
        },
        "command.execute.before": createCommandExecuteHandler(ctx.client, state, logger, config),
        tool: {
            ...(config.tools.compress.permission !== "deny" && {
                compress: createCompressTool({
                    client: ctx.client,
                    state,
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
                compress: config.tools.compress.permission,
            };
        },
    };
});
export default plugin;
//# sourceMappingURL=index.js.map