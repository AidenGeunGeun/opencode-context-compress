import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"

export interface CompressTool {
    permission: "ask" | "allow" | "deny"
    showCompression: boolean
}

export interface ToolSettings {
    protectedTools: string[]
}

export interface Tools {
    settings: ToolSettings
    compress: CompressTool
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface TurnProtection {
    enabled: boolean
    turns: number
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    notification: "off" | "minimal" | "detailed"
    notificationType: "chat" | "toast"
    commands: Commands
    turnProtection: TurnProtection
    protectedFilePatterns: string[]
    tools: Tools
}

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "todowrite",
    "todoread",
    "compress",
    "batch",
    "plan_enter",
    "plan_exit",
]

// Valid config keys for validation against user config
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    "$schema",
    "enabled",
    "debug",
    "showUpdateToasts", // Deprecated but kept for backwards compatibility
    "notification",
    "notificationType",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "tools",
    "tools.settings",
    "tools.settings.protectedTools",
    "tools.compress",
    "tools.compress.permission",
    "tools.compress.showCompression",
])

// Extract all key paths from a config object for validation
function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

// Returns invalid keys found in user config
export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

// Type validators for config values
interface ValidationError {
    key: string
    expected: string
    actual: string
}

function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    // Top-level validators
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }
    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }
    if (config.notification !== undefined) {
        const validValues = ["off", "minimal", "detailed"]
        if (!validValues.includes(config.notification)) {
            errors.push({
                key: "notification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.notification),
            })
        }
    }

    if (config.notificationType !== undefined) {
        const validValues = ["chat", "toast"]
        if (!validValues.includes(config.notificationType)) {
            errors.push({
                key: "notificationType",
                expected: '"chat" | "toast"',
                actual: JSON.stringify(config.notificationType),
            })
        }
    }

    if (config.protectedFilePatterns !== undefined) {
        if (!Array.isArray(config.protectedFilePatterns)) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: typeof config.protectedFilePatterns,
            })
        } else if (!config.protectedFilePatterns.every((v) => typeof v === "string")) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: "non-string entries",
            })
        }
    }

    // Top-level turnProtection validator
    if (config.turnProtection) {
        if (
            config.turnProtection.enabled !== undefined &&
            typeof config.turnProtection.enabled !== "boolean"
        ) {
            errors.push({
                key: "turnProtection.enabled",
                expected: "boolean",
                actual: typeof config.turnProtection.enabled,
            })
        }
        if (
            config.turnProtection.turns !== undefined &&
            typeof config.turnProtection.turns !== "number"
        ) {
            errors.push({
                key: "turnProtection.turns",
                expected: "number",
                actual: typeof config.turnProtection.turns,
            })
        }
    }

    // Commands validator
    const commands = config.commands
    if (commands !== undefined) {
        if (typeof commands === "object") {
            if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
                errors.push({
                    key: "commands.enabled",
                    expected: "boolean",
                    actual: typeof commands.enabled,
                })
            }
            if (commands.protectedTools !== undefined && !Array.isArray(commands.protectedTools)) {
                errors.push({
                    key: "commands.protectedTools",
                    expected: "string[]",
                    actual: typeof commands.protectedTools,
                })
            }
        } else {
            errors.push({
                key: "commands",
                expected: "{ enabled: boolean, protectedTools: string[] }",
                actual: typeof commands,
            })
        }
    }

    // Tools validators
    const tools = config.tools
    if (tools) {
        if (tools.settings) {
            if (
                tools.settings.protectedTools !== undefined &&
                !Array.isArray(tools.settings.protectedTools)
            ) {
                errors.push({
                    key: "tools.settings.protectedTools",
                    expected: "string[]",
                    actual: typeof tools.settings.protectedTools,
                })
            }
        }
        if (tools.compress) {
            if (tools.compress.permission !== undefined) {
                const validValues = ["ask", "allow", "deny"]
                if (!validValues.includes(tools.compress.permission)) {
                    errors.push({
                        key: "tools.compress.permission",
                        expected: '"ask" | "allow" | "deny"',
                        actual: JSON.stringify(tools.compress.permission),
                    })
                }
            }
            if (
                tools.compress.showCompression !== undefined &&
                typeof tools.compress.showCompression !== "boolean"
            ) {
                errors.push({
                    key: "tools.compress.showCompression",
                    expected: "boolean",
                    actual: typeof tools.compress.showCompression,
                })
            }
        }
    }

    return errors
}

// Show validation warnings for a config file
function showConfigValidationWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                    body: {
                        title: `Context Compress: Invalid ${configType}`,
                        message: `${configPath}\n${messages.join("\n")}`,
                        variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "detailed",
    notificationType: "chat",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    protectedFilePatterns: [],
    tools: {
        settings: {
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
        },
        compress: {
            permission: "allow",
            showCompression: false,
        },
    },
}

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "compress.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "compress.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    // Global: ~/.config/opencode/compress.jsonc|json
    let globalPath: string | null = null
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        globalPath = GLOBAL_CONFIG_PATH_JSONC
    } else if (existsSync(GLOBAL_CONFIG_PATH_JSON)) {
        globalPath = GLOBAL_CONFIG_PATH_JSON
    }

    // Custom config directory: $OPENCODE_CONFIG_DIR/compress.jsonc|json
    let configDirPath: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "compress.jsonc")
        const configJson = join(opencodeConfigDir, "compress.json")
        if (existsSync(configJsonc)) {
            configDirPath = configJsonc
        } else if (existsSync(configJson)) {
            configDirPath = configJson
        }
    }

    // Project: <project>/.opencode/compress.jsonc|json
    let projectPath: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "compress.jsonc")
            const projectJson = join(opencodeDir, "compress.json")
            if (existsSync(projectJsonc)) {
                projectPath = projectJsonc
            } else if (existsSync(projectJson)) {
                projectPath = projectJson
            }
        }
    }

    return { global: globalPath, configDir: configDirPath, project: projectPath }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "compress.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent: string
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        // File doesn't exist or can't be read - not a parse error
        return { data: null }
    }

    try {
        const parsed = parse(fileContent)
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

function mergeTools(
    base: PluginConfig["tools"],
    override?: Partial<PluginConfig["tools"]>,
): PluginConfig["tools"] {
    if (!override) return base

    return {
        settings: {
            protectedTools: [
                ...new Set([
                    ...base.settings.protectedTools,
                    ...(override.settings?.protectedTools ?? []),
                ]),
            ],
        },
        compress: {
            permission: override.compress?.permission ?? base.compress.permission,
            showCompression: override.compress?.showCompression ?? base.compress.showCompression,
        },
    }
}

function mergeCommands(
    base: PluginConfig["commands"],
    override?: Partial<PluginConfig["commands"]>,
): PluginConfig["commands"] {
    if (override === undefined) return base

    return {
        enabled: override.enabled ?? base.enabled,
        protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        turnProtection: { ...config.turnProtection },
        protectedFilePatterns: [...config.protectedFilePatterns],
        tools: {
            settings: {
                ...config.tools.settings,
                protectedTools: [...config.tools.settings.protectedTools],
            },
            compress: { ...config.tools.compress },
        },
    }
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    // Load and merge global config
    if (configPaths.global) {
        const result = loadConfigFile(configPaths.global)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "Context Compress: Invalid config",
                            message: `${configPaths.global}\n${result.parseError}\nUsing default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.global, result.data, false)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                notification: result.data.notification ?? config.notification,
                notificationType: result.data.notificationType ?? config.notificationType,
                commands: mergeCommands(config.commands, result.data.commands as any),
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                protectedFilePatterns: [
                    ...new Set([
                        ...config.protectedFilePatterns,
                        ...(result.data.protectedFilePatterns ?? []),
                    ]),
                ],
                tools: mergeTools(config.tools, result.data.tools as any),
            }
        }
    } else {
        // No config exists, create default
        createDefaultConfig()
    }

    // Load and merge $OPENCODE_CONFIG_DIR/compress.jsonc|json (overrides global)
    if (configPaths.configDir) {
        const result = loadConfigFile(configPaths.configDir)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "Context Compress: Invalid configDir config",
                            message: `${configPaths.configDir}\n${result.parseError}\nUsing global/default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.configDir, result.data, true)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                notification: result.data.notification ?? config.notification,
                notificationType: result.data.notificationType ?? config.notificationType,
                commands: mergeCommands(config.commands, result.data.commands as any),
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                protectedFilePatterns: [
                    ...new Set([
                        ...config.protectedFilePatterns,
                        ...(result.data.protectedFilePatterns ?? []),
                    ]),
                ],
                tools: mergeTools(config.tools, result.data.tools as any),
            }
        }
    }

    // Load and merge project config (overrides global)
    if (configPaths.project) {
        const result = loadConfigFile(configPaths.project)
        if (result.parseError) {
            setTimeout(async () => {
                try {
                    ctx.client.tui.showToast({
                        body: {
                            title: "Context Compress: Invalid project config",
                            message: `${configPaths.project}\n${result.parseError}\nUsing global/default values`,
                            variant: "warning",
                            duration: 7000,
                        },
                    })
                } catch {}
            }, 7000)
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.project, result.data, true)
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                notification: result.data.notification ?? config.notification,
                notificationType: result.data.notificationType ?? config.notificationType,
                commands: mergeCommands(config.commands, result.data.commands as any),
                turnProtection: {
                    enabled: result.data.turnProtection?.enabled ?? config.turnProtection.enabled,
                    turns: result.data.turnProtection?.turns ?? config.turnProtection.turns,
                },
                protectedFilePatterns: [
                    ...new Set([
                        ...config.protectedFilePatterns,
                        ...(result.data.protectedFilePatterns ?? []),
                    ]),
                ],
                tools: mergeTools(config.tools, result.data.tools as any),
            }
        }
    }

    return config
}
