import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { parse } from "jsonc-parser"
import { isRecord } from "./shared-utils.js"

export interface ConfigContext {
    directory: string
}

export interface CompressTool {
    permission: "ask" | "allow" | "deny"
    showCompression: boolean
}

export interface Tools {
    compress: CompressTool
}

export interface Commands {
    enabled: boolean
}

export interface AutoCompression {
    enabled: boolean
    contextWindowRatio: number
    tokenThreshold: number
}

export const DEFAULT_AUTO_COMPRESSION: AutoCompression = {
    enabled: true,
    contextWindowRatio: 0.9,
    tokenThreshold: 432_000,
}

// One rule per numeric field, shared by validation warnings and layer merging.
function isProtectedTurns(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isContextWindowRatio(value: unknown): value is number {
    return typeof value === "number" && value > 0 && value <= 1
}

function isTokenThreshold(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
}

export function resolveProtectedTurnsSetting(
    layer: Record<string, unknown>,
    fallback = 3,
    hasExplicitTopLevel = false,
): number {
    if (isProtectedTurns(layer.protectedTurns)) return layer.protectedTurns
    if (hasExplicitTopLevel) return fallback
    const autoCompression = isRecord(layer.autoCompression) ? layer.autoCompression : {}
    return isProtectedTurns(autoCompression.protectedTurns)
        ? autoCompression.protectedTurns
        : fallback
}

const NOTIFICATIONS = ["off", "minimal", "detailed"] as const
const PERMISSIONS = ["ask", "allow", "deny"] as const

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
    return values.some((candidate) => candidate === value)
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    /** Daily activity log. Follows `debug` when left unset. */
    dailyLog?: boolean
    notification: "off" | "minimal" | "detailed"
    protectedTurns: number
    commands: Commands
    autoCompression: AutoCompression
    tools: Tools
}

// Valid config keys for validation against user config
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    "$schema",
    "enabled",
    "debug",
    "dailyLog",
    "notification",
    // Retired with toasts; still accepted so older configs load without warnings.
    "notificationType",
    "protectedTurns",
    "autoCompression",
    "autoCompression.enabled",
    "autoCompression.contextWindowRatio",
    "autoCompression.tokenThreshold",
    "autoCompression.protectedTurns",
    "commands",
    "commands.enabled",
    "tools",
    "tools.compress",
    "tools.compress.permission",
    "tools.compress.showCompression",
])

// Extract all key paths from a config object for validation
function getConfigKeyPaths(obj: Record<string, unknown>, prefix = ""): string[] {
    const keys: string[] = []
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        if (isRecord(value)) {
            keys.push(...getConfigKeyPaths(value, fullKey))
        }
    }
    return keys
}

// Returns invalid keys found in user config
export function getInvalidConfigKeys(userConfig: Record<string, unknown>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

// Type validators for config values
interface ValidationError {
    key: string
    expected: string
    actual: string
}

function validateConfigTypes(config: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = []

    // Top-level validators
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }
    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }
    if (config.dailyLog !== undefined && typeof config.dailyLog !== "boolean") {
        errors.push({ key: "dailyLog", expected: "boolean", actual: typeof config.dailyLog })
    }
    if (config.protectedTurns !== undefined && !isProtectedTurns(config.protectedTurns)) {
        errors.push({
            key: "protectedTurns",
            expected: "non-negative integer",
            actual: JSON.stringify(config.protectedTurns),
        })
    }
    if (config.notification !== undefined) {
        if (!isOneOf(NOTIFICATIONS, config.notification)) {
            errors.push({
                key: "notification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.notification),
            })
        }
    }

    const autoCompression = config.autoCompression
    if (autoCompression !== undefined) {
        if (!isRecord(autoCompression)) {
            errors.push({
                key: "autoCompression",
                expected: "object",
                actual: Array.isArray(autoCompression) ? "array" : typeof autoCompression,
            })
        } else {
            if (
                autoCompression.enabled !== undefined &&
                typeof autoCompression.enabled !== "boolean"
            ) {
                errors.push({
                    key: "autoCompression.enabled",
                    expected: "boolean",
                    actual: typeof autoCompression.enabled,
                })
            }
            if (
                autoCompression.contextWindowRatio !== undefined &&
                !isContextWindowRatio(autoCompression.contextWindowRatio)
            ) {
                errors.push({
                    key: "autoCompression.contextWindowRatio",
                    expected: "number greater than 0 and at most 1",
                    actual: JSON.stringify(autoCompression.contextWindowRatio),
                })
            }
            if (
                autoCompression.tokenThreshold !== undefined &&
                !isTokenThreshold(autoCompression.tokenThreshold)
            ) {
                errors.push({
                    key: "autoCompression.tokenThreshold",
                    expected: "positive finite number",
                    actual: JSON.stringify(autoCompression.tokenThreshold),
                })
            }
            if (
                autoCompression.protectedTurns !== undefined &&
                !isProtectedTurns(autoCompression.protectedTurns)
            ) {
                errors.push({
                    key: "autoCompression.protectedTurns",
                    expected: "non-negative integer",
                    actual: JSON.stringify(autoCompression.protectedTurns),
                })
            }
        }
    }

    // Commands validator
    const commands = config.commands
    if (commands !== undefined) {
        if (isRecord(commands)) {
            if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
                errors.push({
                    key: "commands.enabled",
                    expected: "boolean",
                    actual: typeof commands.enabled,
                })
            }
        } else {
            errors.push({
                key: "commands",
                expected: "{ enabled: boolean }",
                actual: typeof commands,
            })
        }
    }

    // Tools validators
    const tools = config.tools
    if (isRecord(tools) && isRecord(tools.compress)) {
        const compress = tools.compress
        if (compress.permission !== undefined) {
            if (!isOneOf(PERMISSIONS, compress.permission)) {
                errors.push({
                    key: "tools.compress.permission",
                    expected: '"ask" | "allow" | "deny"',
                    actual: JSON.stringify(compress.permission),
                })
            }
        }
        if (
            compress.showCompression !== undefined &&
            typeof compress.showCompression !== "boolean"
        ) {
            errors.push({
                key: "tools.compress.showCompression",
                expected: "boolean",
                actual: typeof compress.showCompression,
            })
        }
    }

    return errors
}

// Show validation warnings for a config file
function showConfigValidationWarnings(
    configPath: string,
    configData: Record<string, unknown>,
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

    console.warn(`Context Compress: Invalid ${configType}\n${configPath}\n${messages.join("\n")}`)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    notification: "detailed",
    protectedTurns: 3,
    commands: {
        enabled: true,
    },
    autoCompression: { ...DEFAULT_AUTO_COMPRESSION },
    tools: {
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

function getConfigPaths(ctx?: ConfigContext): {
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
  "$schema": "https://unpkg.com/@skybluejacket/opencode-context-compress@1/compress.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, unknown> | null
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
        const parsed: unknown = parse(fileContent)
        if (!isRecord(parsed)) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error) {
        return {
            data: null,
            parseError:
                error instanceof Error && error.message ? error.message : "Failed to parse config",
        }
    }
}

function mergeTools(base: PluginConfig["tools"], override: unknown): PluginConfig["tools"] {
    if (!isRecord(override)) return base

    const compress = isRecord(override.compress) ? override.compress : {}
    return {
        compress: {
            permission: isOneOf(PERMISSIONS, compress.permission)
                ? compress.permission
                : base.compress.permission,
            showCompression:
                typeof compress.showCompression === "boolean"
                    ? compress.showCompression
                    : base.compress.showCompression,
        },
    }
}

function mergeCommands(
    base: PluginConfig["commands"],
    override: unknown,
): PluginConfig["commands"] {
    if (!isRecord(override)) return base

    return {
        enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
    }
}

function mergeAutoCompression(
    base: PluginConfig["autoCompression"],
    override: unknown,
): PluginConfig["autoCompression"] {
    if (!isRecord(override)) return base

    return {
        enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
        contextWindowRatio: isContextWindowRatio(override.contextWindowRatio)
            ? override.contextWindowRatio
            : base.contextWindowRatio,
        tokenThreshold: isTokenThreshold(override.tokenThreshold)
            ? override.tokenThreshold
            : base.tokenThreshold,
    }
}

function mergeConfigLayer(
    config: PluginConfig,
    data: Record<string, unknown>,
    hasExplicitProtectedTurns: boolean,
): PluginConfig {
    return {
        enabled: typeof data.enabled === "boolean" ? data.enabled : config.enabled,
        debug: typeof data.debug === "boolean" ? data.debug : config.debug,
        dailyLog: typeof data.dailyLog === "boolean" ? data.dailyLog : config.dailyLog,
        notification: isOneOf(NOTIFICATIONS, data.notification)
            ? data.notification
            : config.notification,
        protectedTurns: resolveProtectedTurnsSetting(
            data,
            config.protectedTurns,
            hasExplicitProtectedTurns,
        ),
        commands: mergeCommands(config.commands, data.commands),
        autoCompression: mergeAutoCompression(config.autoCompression, data.autoCompression),
        tools: mergeTools(config.tools, data.tools),
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: { ...config.commands },
        autoCompression: { ...config.autoCompression },
        tools: {
            compress: { ...config.tools.compress },
        },
    }
}

export function getConfig(ctx: ConfigContext): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    let hasExplicitProtectedTurns = false
    const configPaths = getConfigPaths(ctx)

    // Load and merge global config
    if (configPaths.global) {
        const result = loadConfigFile(configPaths.global)
        if (result.parseError) {
            console.warn(
                `Context Compress: Invalid config\n${configPaths.global}\n${result.parseError}\nUsing default values`,
            )
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(configPaths.global, result.data, false)
            config = mergeConfigLayer(config, result.data, hasExplicitProtectedTurns)
            hasExplicitProtectedTurns = isProtectedTurns(result.data.protectedTurns)
        }
    } else {
        // No config exists, create default
        createDefaultConfig()
    }

    // Load and merge $OPENCODE_CONFIG_DIR/compress.jsonc|json (overrides global)
    if (configPaths.configDir) {
        const result = loadConfigFile(configPaths.configDir)
        if (result.parseError) {
            console.warn(
                `Context Compress: Invalid configDir config\n${configPaths.configDir}\n${result.parseError}\nUsing global/default values`,
            )
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(configPaths.configDir, result.data, true)
            config = mergeConfigLayer(config, result.data, hasExplicitProtectedTurns)
            hasExplicitProtectedTurns =
                hasExplicitProtectedTurns || isProtectedTurns(result.data.protectedTurns)
        }
    }

    // Load and merge project config (overrides global)
    if (configPaths.project) {
        const result = loadConfigFile(configPaths.project)
        if (result.parseError) {
            console.warn(
                `Context Compress: Invalid project config\n${configPaths.project}\n${result.parseError}\nUsing global/default values`,
            )
        } else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(configPaths.project, result.data, true)
            config = mergeConfigLayer(config, result.data, hasExplicitProtectedTurns)
            hasExplicitProtectedTurns =
                hasExplicitProtectedTurns || isProtectedTurns(result.data.protectedTurns)
        }
    }

    return config
}
