import type { SessionStateManager } from "../state/index.js"
import type { PluginConfig } from "../config.js"
import type { Logger } from "../logger.js"

export interface CompressToolContext {
    client: any
    stateManager: SessionStateManager
    logger: Logger
    config: PluginConfig
}

export interface ToolExecutionContext {
    readonly sessionID: string
    readonly agent: string
    readonly messageID: string
    readonly id?: string
    readonly callID?: string
}

export interface ToolDefinition<Input extends object> {
    readonly description: string
    readonly args: Record<keyof Input, { readonly type: "string"; readonly description: string }>
    readonly execute: (input: Input, context: ToolExecutionContext) => Promise<string>
}
