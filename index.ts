import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config.js"
import { Logger } from "./lib/logger.js"
import { SessionStateManager } from "./lib/state/index.js"
import { createCompressMapTool, createCompressTool } from "./lib/tools/index.js"
import { createChatMessageTransformHandler, createCommandExecuteHandler } from "./lib/hooks.js"
import { configureClientAuth, isSecureMode } from "./lib/auth.js"
import {
    createAutomaticCompressionEventHandler,
    createChatParamsHandler,
} from "./lib/auto-compression.js"

const stateManager = new SessionStateManager()

const plugin: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
        // logger.info("Secure mode detected, configured client authentication")
    }

    logger.info("Context Compress initialized")

    const hooks = {
        event: createAutomaticCompressionEventHandler(
            ctx.client,
            stateManager,
            logger,
            config,
        ),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            stateManager,
            logger,
            config,
            ctx.directory,
        ) as any,
        "chat.params": createChatParamsHandler(stateManager),
        "chat.message": async (
            input: {
                sessionID: string
                agent?: string
                model?: { providerID: string; modelID: string }
                messageID?: string
                variant?: string
            },
            _output: any,
        ) => {
            // Cache variant from real user messages (not synthetic)
            // This avoids scanning all messages to find variant
            stateManager.get(input.sessionID).variant = input.variant
            logger.debug("Cached variant from chat.message hook", { variant: input.variant })
        },
        "command.execute.before": createCommandExecuteHandler(
            ctx.client,
            stateManager,
            logger,
            config,
        ),
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
        config: async (opencodeConfig: any) => {
            if (config.autoCompression.enabled) {
                opencodeConfig.compaction = {
                    ...opencodeConfig.compaction,
                    auto: false,
                }
            }

            if (config.commands.enabled) {
                opencodeConfig.command ??= {}
                opencodeConfig.command["compress"] = {
                    template: "",
                    description: "Show available context compression commands",
                }
            }

            const toolsToAdd: string[] = []
            if (config.tools.compress_map.permission !== "deny") toolsToAdd.push("compress_map")
            if (config.tools.compress.permission !== "deny") toolsToAdd.push("compress")

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
                logger.info(
                    `Added ${toolsToAdd.map((t) => `'${t}'`).join(" and ")} to experimental.primary_tools via config mutation`,
                )
            }

            // Set tool permissions from plugin config
            const permission = opencodeConfig.permission ?? {}
            opencodeConfig.permission = {
                ...permission,
                compress_map: config.tools.compress_map.permission,
                compress: config.tools.compress.permission,
            } as typeof permission
        },
    } as any

    return hooks
}) satisfies Plugin

export default plugin
