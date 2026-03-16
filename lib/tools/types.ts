import type { SessionStateManager } from "../state"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"

export interface CompressToolContext {
    client: any
    stateManager: SessionStateManager
    logger: Logger
    config: PluginConfig
    workingDirectory: string
}
