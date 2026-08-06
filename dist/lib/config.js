import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { parse } from "jsonc-parser";
import { showToast } from "./sdk/client.js";
export const DEFAULT_AUTO_COMPRESSION = {
    enabled: true,
    contextWindowRatio: 0.9,
    tokenThreshold: 330_000,
};
export function resolveProtectedTurnsSetting(layer, fallback = 3, hasExplicitTopLevel = false) {
    if (layer.protectedTurns !== undefined)
        return layer.protectedTurns;
    if (hasExplicitTopLevel)
        return fallback;
    return layer.autoCompression?.protectedTurns ?? fallback;
}
// Valid config keys for validation against user config
export const VALID_CONFIG_KEYS = new Set([
    // Top-level keys
    "$schema",
    "enabled",
    "debug",
    "dailyLog",
    "notification",
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
]);
// Extract all key paths from a config object for validation
function getConfigKeyPaths(obj, prefix = "") {
    const keys = [];
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        keys.push(fullKey);
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey));
        }
    }
    return keys;
}
// Returns invalid keys found in user config
export function getInvalidConfigKeys(userConfig) {
    const userKeys = getConfigKeyPaths(userConfig);
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key));
}
function validateConfigTypes(config) {
    const errors = [];
    // Top-level validators
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled });
    }
    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug });
    }
    if (config.dailyLog !== undefined && typeof config.dailyLog !== "boolean") {
        errors.push({ key: "dailyLog", expected: "boolean", actual: typeof config.dailyLog });
    }
    if (config.protectedTurns !== undefined &&
        (typeof config.protectedTurns !== "number" ||
            !Number.isInteger(config.protectedTurns) ||
            config.protectedTurns < 0)) {
        errors.push({
            key: "protectedTurns",
            expected: "non-negative integer",
            actual: JSON.stringify(config.protectedTurns),
        });
    }
    if (config.notification !== undefined) {
        const validValues = ["off", "minimal", "detailed"];
        if (!validValues.includes(config.notification)) {
            errors.push({
                key: "notification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.notification),
            });
        }
    }
    if (config.notificationType !== undefined) {
        const validValues = ["chat", "toast"];
        if (!validValues.includes(config.notificationType)) {
            errors.push({
                key: "notificationType",
                expected: '"chat" | "toast"',
                actual: JSON.stringify(config.notificationType),
            });
        }
    }
    const autoCompression = config.autoCompression;
    if (autoCompression !== undefined) {
        if (!autoCompression || typeof autoCompression !== "object" || Array.isArray(autoCompression)) {
            errors.push({
                key: "autoCompression",
                expected: "object",
                actual: Array.isArray(autoCompression) ? "array" : typeof autoCompression,
            });
        }
        else {
            if (autoCompression.enabled !== undefined &&
                typeof autoCompression.enabled !== "boolean") {
                errors.push({
                    key: "autoCompression.enabled",
                    expected: "boolean",
                    actual: typeof autoCompression.enabled,
                });
            }
            if (autoCompression.contextWindowRatio !== undefined &&
                (typeof autoCompression.contextWindowRatio !== "number" ||
                    autoCompression.contextWindowRatio <= 0 ||
                    autoCompression.contextWindowRatio > 1)) {
                errors.push({
                    key: "autoCompression.contextWindowRatio",
                    expected: "number greater than 0 and at most 1",
                    actual: JSON.stringify(autoCompression.contextWindowRatio),
                });
            }
            if (autoCompression.tokenThreshold !== undefined &&
                (typeof autoCompression.tokenThreshold !== "number" ||
                    !Number.isFinite(autoCompression.tokenThreshold) ||
                    autoCompression.tokenThreshold <= 0)) {
                errors.push({
                    key: "autoCompression.tokenThreshold",
                    expected: "positive finite number",
                    actual: JSON.stringify(autoCompression.tokenThreshold),
                });
            }
            if (autoCompression.protectedTurns !== undefined &&
                (typeof autoCompression.protectedTurns !== "number" ||
                    !Number.isInteger(autoCompression.protectedTurns) ||
                    autoCompression.protectedTurns < 0)) {
                errors.push({
                    key: "autoCompression.protectedTurns",
                    expected: "non-negative integer",
                    actual: JSON.stringify(autoCompression.protectedTurns),
                });
            }
        }
    }
    // Commands validator
    const commands = config.commands;
    if (commands !== undefined) {
        if (typeof commands === "object") {
            if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
                errors.push({
                    key: "commands.enabled",
                    expected: "boolean",
                    actual: typeof commands.enabled,
                });
            }
        }
        else {
            errors.push({
                key: "commands",
                expected: "{ enabled: boolean }",
                actual: typeof commands,
            });
        }
    }
    // Tools validators
    const tools = config.tools;
    if (tools) {
        if (tools.compress) {
            if (tools.compress.permission !== undefined) {
                const validValues = ["ask", "allow", "deny"];
                if (!validValues.includes(tools.compress.permission)) {
                    errors.push({
                        key: "tools.compress.permission",
                        expected: '"ask" | "allow" | "deny"',
                        actual: JSON.stringify(tools.compress.permission),
                    });
                }
            }
            if (tools.compress.showCompression !== undefined &&
                typeof tools.compress.showCompression !== "boolean") {
                errors.push({
                    key: "tools.compress.showCompression",
                    expected: "boolean",
                    actual: typeof tools.compress.showCompression,
                });
            }
        }
    }
    return errors;
}
// Show validation warnings for a config file
function showConfigValidationWarnings(ctx, configPath, configData, isProject) {
    const invalidKeys = getInvalidConfigKeys(configData);
    const typeErrors = validateConfigTypes(configData);
    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return;
    }
    const configType = isProject ? "project config" : "config";
    const messages = [];
    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ");
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : "";
        messages.push(`Unknown keys: ${keyList}${suffix}`);
    }
    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`);
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`);
        }
    }
    setTimeout(() => {
        void showToast(ctx.client, {
            title: `Context Compress: Invalid ${configType}`,
            message: `${configPath}\n${messages.join("\n")}`,
            variant: "warning",
            duration: 7000,
        });
    }, 7000);
}
const defaultConfig = {
    enabled: true,
    debug: false,
    notification: "detailed",
    notificationType: "chat",
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
};
const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "compress.jsonc");
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "compress.json");
function findOpencodeDir(startDir) {
    let current = startDir;
    while (current !== "/") {
        const candidate = join(current, ".opencode");
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate;
        }
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return null;
}
function getConfigPaths(ctx) {
    // Global: ~/.config/opencode/compress.jsonc|json
    let globalPath = null;
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        globalPath = GLOBAL_CONFIG_PATH_JSONC;
    }
    else if (existsSync(GLOBAL_CONFIG_PATH_JSON)) {
        globalPath = GLOBAL_CONFIG_PATH_JSON;
    }
    // Custom config directory: $OPENCODE_CONFIG_DIR/compress.jsonc|json
    let configDirPath = null;
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "compress.jsonc");
        const configJson = join(opencodeConfigDir, "compress.json");
        if (existsSync(configJsonc)) {
            configDirPath = configJsonc;
        }
        else if (existsSync(configJson)) {
            configDirPath = configJson;
        }
    }
    // Project: <project>/.opencode/compress.jsonc|json
    let projectPath = null;
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory);
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "compress.jsonc");
            const projectJson = join(opencodeDir, "compress.json");
            if (existsSync(projectJsonc)) {
                projectPath = projectJsonc;
            }
            else if (existsSync(projectJson)) {
                projectPath = projectJson;
            }
        }
    }
    return { global: globalPath, configDir: configDirPath, project: projectPath };
}
function createDefaultConfig() {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    }
    const configContent = `{
  "$schema": "compress.schema.json"
}
`;
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8");
}
function loadConfigFile(configPath) {
    let fileContent;
    try {
        fileContent = readFileSync(configPath, "utf-8");
    }
    catch {
        // File doesn't exist or can't be read - not a parse error
        return { data: null };
    }
    try {
        const parsed = parse(fileContent);
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" };
        }
        return { data: parsed };
    }
    catch (error) {
        return { data: null, parseError: error.message || "Failed to parse config" };
    }
}
function mergeTools(base, override) {
    if (!override)
        return base;
    return {
        compress: {
            permission: override.compress?.permission ?? base.compress.permission,
            showCompression: override.compress?.showCompression ?? base.compress.showCompression,
        },
    };
}
function mergeCommands(base, override) {
    if (override === undefined)
        return base;
    return {
        enabled: override.enabled ?? base.enabled,
    };
}
function mergeAutoCompression(base, override) {
    if (override === undefined)
        return base;
    return {
        enabled: override.enabled ?? base.enabled,
        contextWindowRatio: override.contextWindowRatio ?? base.contextWindowRatio,
        tokenThreshold: override.tokenThreshold ?? base.tokenThreshold,
    };
}
function deepCloneConfig(config) {
    return {
        ...config,
        commands: { ...config.commands },
        autoCompression: { ...config.autoCompression },
        tools: {
            compress: { ...config.tools.compress },
        },
    };
}
export function getConfig(ctx) {
    let config = deepCloneConfig(defaultConfig);
    let hasExplicitProtectedTurns = false;
    const configPaths = getConfigPaths(ctx);
    // Load and merge global config
    if (configPaths.global) {
        const result = loadConfigFile(configPaths.global);
        if (result.parseError) {
            setTimeout(async () => {
                await showToast(ctx.client, {
                    title: "Context Compress: Invalid config",
                    message: `${configPaths.global}\n${result.parseError}\nUsing default values`,
                    variant: "warning",
                    duration: 7000,
                });
            }, 7000);
        }
        else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.global, result.data, false);
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                dailyLog: result.data.dailyLog ?? config.dailyLog,
                notification: result.data.notification ?? config.notification,
                notificationType: result.data.notificationType ?? config.notificationType,
                protectedTurns: resolveProtectedTurnsSetting(result.data, config.protectedTurns, hasExplicitProtectedTurns),
                commands: mergeCommands(config.commands, result.data.commands),
                autoCompression: mergeAutoCompression(config.autoCompression, result.data.autoCompression),
                tools: mergeTools(config.tools, result.data.tools),
            };
            hasExplicitProtectedTurns = result.data.protectedTurns !== undefined;
        }
    }
    else {
        // No config exists, create default
        createDefaultConfig();
    }
    // Load and merge $OPENCODE_CONFIG_DIR/compress.jsonc|json (overrides global)
    if (configPaths.configDir) {
        const result = loadConfigFile(configPaths.configDir);
        if (result.parseError) {
            setTimeout(async () => {
                await showToast(ctx.client, {
                    title: "Context Compress: Invalid configDir config",
                    message: `${configPaths.configDir}\n${result.parseError}\nUsing global/default values`,
                    variant: "warning",
                    duration: 7000,
                });
            }, 7000);
        }
        else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.configDir, result.data, true);
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                dailyLog: result.data.dailyLog ?? config.dailyLog,
                notification: result.data.notification ?? config.notification,
                notificationType: result.data.notificationType ?? config.notificationType,
                protectedTurns: resolveProtectedTurnsSetting(result.data, config.protectedTurns, hasExplicitProtectedTurns),
                commands: mergeCommands(config.commands, result.data.commands),
                autoCompression: mergeAutoCompression(config.autoCompression, result.data.autoCompression),
                tools: mergeTools(config.tools, result.data.tools),
            };
            hasExplicitProtectedTurns =
                hasExplicitProtectedTurns || result.data.protectedTurns !== undefined;
        }
    }
    // Load and merge project config (overrides global)
    if (configPaths.project) {
        const result = loadConfigFile(configPaths.project);
        if (result.parseError) {
            setTimeout(async () => {
                await showToast(ctx.client, {
                    title: "Context Compress: Invalid project config",
                    message: `${configPaths.project}\n${result.parseError}\nUsing global/default values`,
                    variant: "warning",
                    duration: 7000,
                });
            }, 7000);
        }
        else if (result.data) {
            // Validate config keys and types
            showConfigValidationWarnings(ctx, configPaths.project, result.data, true);
            config = {
                enabled: result.data.enabled ?? config.enabled,
                debug: result.data.debug ?? config.debug,
                dailyLog: result.data.dailyLog ?? config.dailyLog,
                notification: result.data.notification ?? config.notification,
                notificationType: result.data.notificationType ?? config.notificationType,
                protectedTurns: resolveProtectedTurnsSetting(result.data, config.protectedTurns, hasExplicitProtectedTurns),
                commands: mergeCommands(config.commands, result.data.commands),
                autoCompression: mergeAutoCompression(config.autoCompression, result.data.autoCompression),
                tools: mergeTools(config.tools, result.data.tools),
            };
            hasExplicitProtectedTurns =
                hasExplicitProtectedTurns || result.data.protectedTurns !== undefined;
        }
    }
    return config;
}
//# sourceMappingURL=config.js.map