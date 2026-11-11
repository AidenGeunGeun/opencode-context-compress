// @bun
// index.ts
import { Plugin } from "@opencode/plugin";

// lib/plugin.ts
import { z } from "zod";

// lib/config.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { parse } from "jsonc-parser";

// lib/messages/utils.ts
import { ulid } from "ulid";
import { createHash } from "crypto";
var COMPRESS_SUMMARY_PREFIX = `[Compressed conversation block]

`;
var generateUniqueId = (prefix) => `${prefix}_${ulid()}`;
var generateStableId = (prefix, seed) => `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
var createSyntheticUserMessage = (baseMessage, content, variant, stableSeed) => {
  const info = baseMessage.info;
  const now = stableSeed ? info.time.created : Date.now();
  const messageId = stableSeed ? generateStableId("msg", stableSeed) : generateUniqueId("msg");
  const partId = stableSeed ? generateStableId("prt", stableSeed) : generateUniqueId("prt");
  return {
    info: {
      id: messageId,
      sessionID: info.sessionID,
      role: "user",
      agent: info.agent,
      model: info.model,
      time: { created: now },
      ...variant !== undefined && { variant }
    },
    parts: [
      {
        id: partId,
        sessionID: info.sessionID,
        messageID: messageId,
        type: "text",
        text: content
      }
    ]
  };
};
var isIgnoredUserMessage = (message) => {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.length === 0) {
    return true;
  }
  for (const part of parts) {
    if (!("ignored" in part) || !part.ignored) {
      return false;
    }
  }
  return true;
};

// lib/shared-utils.ts
var isMessageCompacted = (state, msg) => {
  if (msg.info.time.created < state.lastCompaction) {
    return true;
  }
  if (state.compressed.messageIds.has(msg.info.id)) {
    return true;
  }
  return false;
};
var getLastUserMessage = (messages, startIndex) => {
  const start = startIndex ?? messages.length - 1;
  for (let i = start;i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
      return msg;
    }
  }
  return null;
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// lib/config.ts
var DEFAULT_AUTO_COMPRESSION = {
  enabled: true,
  contextWindowRatio: 0.9,
  tokenThreshold: 432000
};
function isContextWindowRatio(value) {
  return typeof value === "number" && value > 0 && value <= 1;
}
function isTokenThreshold(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
var PERMISSIONS = ["ask", "allow", "deny"];
function isOneOf(values, value) {
  return values.some((candidate) => candidate === value);
}
var VALID_CONFIG_KEYS = new Set([
  "$schema",
  "enabled",
  "debug",
  "dailyLog",
  "autoCompression",
  "autoCompression.enabled",
  "autoCompression.contextWindowRatio",
  "autoCompression.tokenThreshold",
  "commands",
  "commands.enabled",
  "tools",
  "tools.compress",
  "tools.compress.permission"
]);
function getConfigKeyPaths(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey);
    if (isRecord(value)) {
      keys.push(...getConfigKeyPaths(value, fullKey));
    }
  }
  return keys;
}
function getInvalidConfigKeys(userConfig) {
  const userKeys = getConfigKeyPaths(userConfig);
  return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key));
}
function typeName(value) {
  if (value === null)
    return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
function validateConfigTypes(config) {
  const errors = [];
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    errors.push({ key: "enabled", expected: "boolean", actual: typeName(config.enabled) });
  }
  if (config.debug !== undefined && typeof config.debug !== "boolean") {
    errors.push({ key: "debug", expected: "boolean", actual: typeName(config.debug) });
  }
  if (config.dailyLog !== undefined && typeof config.dailyLog !== "boolean") {
    errors.push({ key: "dailyLog", expected: "boolean", actual: typeName(config.dailyLog) });
  }
  const autoCompression = config.autoCompression;
  if (autoCompression !== undefined) {
    if (!isRecord(autoCompression)) {
      errors.push({
        key: "autoCompression",
        expected: "object",
        actual: typeName(autoCompression)
      });
    } else {
      if (autoCompression.enabled !== undefined && typeof autoCompression.enabled !== "boolean") {
        errors.push({
          key: "autoCompression.enabled",
          expected: "boolean",
          actual: typeName(autoCompression.enabled)
        });
      }
      if (autoCompression.contextWindowRatio !== undefined && !isContextWindowRatio(autoCompression.contextWindowRatio)) {
        errors.push({
          key: "autoCompression.contextWindowRatio",
          expected: "number greater than 0 and at most 1",
          actual: JSON.stringify(autoCompression.contextWindowRatio)
        });
      }
      if (autoCompression.tokenThreshold !== undefined && !isTokenThreshold(autoCompression.tokenThreshold)) {
        errors.push({
          key: "autoCompression.tokenThreshold",
          expected: "positive finite number",
          actual: JSON.stringify(autoCompression.tokenThreshold)
        });
      }
    }
  }
  const commands = config.commands;
  if (commands !== undefined) {
    if (isRecord(commands)) {
      if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
        errors.push({
          key: "commands.enabled",
          expected: "boolean",
          actual: typeName(commands.enabled)
        });
      }
    } else {
      errors.push({
        key: "commands",
        expected: "{ enabled: boolean }",
        actual: typeName(commands)
      });
    }
  }
  const tools = config.tools;
  if (isRecord(tools) && isRecord(tools.compress)) {
    const compress = tools.compress;
    if (compress.permission !== undefined) {
      if (!isOneOf(PERMISSIONS, compress.permission)) {
        errors.push({
          key: "tools.compress.permission",
          expected: '"ask" | "allow" | "deny"',
          actual: JSON.stringify(compress.permission)
        });
      }
    }
  }
  return errors;
}
function showConfigValidationWarnings(configPath, configData, isProject) {
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
  console.warn(`Context Compress: Invalid ${configType}
${configPath}
${messages.join(`
`)}`);
}
var defaultConfig = {
  enabled: true,
  debug: false,
  commands: {
    enabled: true
  },
  autoCompression: { ...DEFAULT_AUTO_COMPRESSION },
  tools: {
    compress: {
      permission: "allow"
    }
  }
};
var GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "opencode") : join(homedir(), ".config", "opencode");
var GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "compress.jsonc");
var GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "compress.json");
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
  let globalPath = null;
  if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
    globalPath = GLOBAL_CONFIG_PATH_JSONC;
  } else if (existsSync(GLOBAL_CONFIG_PATH_JSON)) {
    globalPath = GLOBAL_CONFIG_PATH_JSON;
  }
  let configDirPath = null;
  const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  if (opencodeConfigDir) {
    const configJsonc = join(opencodeConfigDir, "compress.jsonc");
    const configJson = join(opencodeConfigDir, "compress.json");
    if (existsSync(configJsonc)) {
      configDirPath = configJsonc;
    } else if (existsSync(configJson)) {
      configDirPath = configJson;
    }
  }
  let projectPath = null;
  if (ctx?.directory) {
    const opencodeDir = findOpencodeDir(ctx.directory);
    if (opencodeDir) {
      const projectJsonc = join(opencodeDir, "compress.jsonc");
      const projectJson = join(opencodeDir, "compress.json");
      if (existsSync(projectJsonc)) {
        projectPath = projectJsonc;
      } else if (existsSync(projectJson)) {
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
  "$schema": "https://unpkg.com/@skybluejacket/opencode-context-compress@1/compress.schema.json"
}
`;
  writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8");
}
function loadConfigFile(configPath) {
  let fileContent;
  try {
    fileContent = readFileSync(configPath, "utf-8");
  } catch {
    return { data: null };
  }
  try {
    const parsed = parse(fileContent);
    if (!isRecord(parsed)) {
      return { data: null, parseError: "Config file is empty or invalid" };
    }
    return { data: parsed };
  } catch (error) {
    return {
      data: null,
      parseError: error instanceof Error && error.message ? error.message : "Failed to parse config"
    };
  }
}
function mergeTools(base, override) {
  if (!isRecord(override))
    return base;
  const compress = isRecord(override.compress) ? override.compress : {};
  return {
    compress: {
      permission: isOneOf(PERMISSIONS, compress.permission) ? compress.permission : base.compress.permission
    }
  };
}
function mergeCommands(base, override) {
  if (!isRecord(override))
    return base;
  return {
    enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled
  };
}
function mergeAutoCompression(base, override) {
  if (!isRecord(override))
    return base;
  return {
    enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
    contextWindowRatio: isContextWindowRatio(override.contextWindowRatio) ? override.contextWindowRatio : base.contextWindowRatio,
    tokenThreshold: isTokenThreshold(override.tokenThreshold) ? override.tokenThreshold : base.tokenThreshold
  };
}
function mergeConfigLayer(config, data) {
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : config.enabled,
    debug: typeof data.debug === "boolean" ? data.debug : config.debug,
    dailyLog: typeof data.dailyLog === "boolean" ? data.dailyLog : config.dailyLog,
    commands: mergeCommands(config.commands, data.commands),
    autoCompression: mergeAutoCompression(config.autoCompression, data.autoCompression),
    tools: mergeTools(config.tools, data.tools)
  };
}
function deepCloneConfig(config) {
  return {
    ...config,
    commands: { ...config.commands },
    autoCompression: { ...config.autoCompression },
    tools: {
      compress: { ...config.tools.compress }
    }
  };
}
var signatures = new WeakMap;
function configSignature(paths) {
  return [paths.global, paths.configDir, paths.project].map((path) => path ? `${path}:${statSync(path, { throwIfNoEntry: false })?.mtimeMs}` : "").join("|");
}
function refreshConfig(config, ctx) {
  if (signatures.get(config) === configSignature(getConfigPaths(ctx)))
    return;
  const fresh = getConfig(ctx);
  Object.assign(config, fresh);
  signatures.set(config, signatures.get(fresh) ?? "");
}
function getConfig(ctx) {
  let config = deepCloneConfig(defaultConfig);
  const configPaths = getConfigPaths(ctx);
  const signature = configSignature(configPaths);
  if (configPaths.global) {
    const result = loadConfigFile(configPaths.global);
    if (result.parseError) {
      console.warn(`Context Compress: Invalid config
${configPaths.global}
${result.parseError}
Using default values`);
    } else if (result.data) {
      showConfigValidationWarnings(configPaths.global, result.data, false);
      config = mergeConfigLayer(config, result.data);
    }
  } else {
    createDefaultConfig();
  }
  if (configPaths.configDir) {
    const result = loadConfigFile(configPaths.configDir);
    if (result.parseError) {
      console.warn(`Context Compress: Invalid configDir config
${configPaths.configDir}
${result.parseError}
Using global/default values`);
    } else if (result.data) {
      showConfigValidationWarnings(configPaths.configDir, result.data, true);
      config = mergeConfigLayer(config, result.data);
    }
  }
  if (configPaths.project) {
    const result = loadConfigFile(configPaths.project);
    if (result.parseError) {
      console.warn(`Context Compress: Invalid project config
${configPaths.project}
${result.parseError}
Using global/default values`);
    } else if (result.data) {
      showConfigValidationWarnings(configPaths.project, result.data, true);
      config = mergeConfigLayer(config, result.data);
    }
  }
  signatures.set(config, signature);
  return config;
}

// lib/messages/v2-adapter.ts
function adaptProjectedMessages(sessionID, values, selection) {
  const seen = new Set;
  let parentID;
  return values.filter((value) => !isRecord(value) || value.type !== "idle").map((value) => {
    const message = requireRecord(value, "session message");
    const id = requireString(message.id, "session message id");
    if (seen.has(id))
      throw new Error(`Duplicate projected session message ID: ${id}`);
    seen.add(id);
    const type = requireString(message.type, `session message ${id} type`);
    const time = requireRecord(message.time, `session message ${id} time`);
    const created = requireNumber(time.created, `session message ${id} created time`);
    if (type === "user") {
      parentID = id;
      return user(sessionID, id, created, message, selection);
    }
    if (type === "synthetic")
      return synthetic(sessionID, id, created, message, selection);
    if (type === "assistant")
      return assistant(sessionID, id, created, message, time, parentID);
    if (type === "compaction")
      return compaction(sessionID, id, created, message);
    if (type === "system" || type === "skill") {
      return system(sessionID, id, created, type, typeof message.text === "string" ? message.text : "");
    }
    if (type === "shell") {
      const output = isRecord(message.output) && typeof message.output.output === "string" ? message.output.output : "";
      const entry = system(sessionID, id, created, type, `The following shell command was executed by the user:

Command:
${String(message.command ?? "")}

Output:
${output}`);
      entry.info.finish = message.status === "running" ? undefined : "stop";
      return entry;
    }
    if (type === "location-switched") {
      const location = isRecord(message.location) ? message.location.directory : undefined;
      return system(sessionID, id, created, type, typeof location === "string" ? `The working directory has been changed to ${location}.` : "");
    }
    if (type === "agent-switched" || type === "model-switched")
      return system(sessionID, id, created, type, "");
    throw new Error(`Unsupported projected session message type: ${type}`);
  });
}
function user(sessionID, id, created, message, selection) {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      sourceType: "user",
      agent: selection?.agent,
      model: selection?.model ? { providerID: selection.model.providerID, modelID: selection.model.id } : undefined,
      variant: selection?.model?.variant,
      time: { created }
    },
    parts: [
      ...typeof message.text === "string" && message.text.length > 0 ? [{ type: "text", text: message.text }] : [],
      ...(Array.isArray(message.files) ? message.files : []).filter(isRecord).map((file) => ({ type: "file", mime: file.mime, filename: file.name }))
    ]
  };
}
function synthetic(sessionID, id, created, message, selection) {
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  return {
    info: {
      id,
      sessionID,
      role: "user",
      sourceType: "synthetic",
      agent: selection?.agent,
      model: selection?.model ? { providerID: selection.model.providerID, modelID: selection.model.id } : undefined,
      variant: selection?.model?.variant,
      time: { created }
    },
    parts: [
      {
        type: "text",
        text: typeof message.text === "string" ? message.text : "",
        synthetic: true,
        ...metadata["opencode.context-compress.ignored"] === true ? { ignored: true } : {}
      }
    ]
  };
}
function assistant(sessionID, id, created, message, time, parentID) {
  const model = requireRecord(message.model, `assistant message ${id} model`);
  const providerID = requireString(model.providerID, `assistant message ${id} provider`);
  const modelID = requireString(model.id, `assistant message ${id} model id`);
  const completed = typeof time.completed === "number" ? time.completed : undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      sourceType: "assistant",
      ...parentID ? { parentID } : {},
      time: { created, ...completed === undefined ? {} : { completed } },
      agent: typeof message.agent === "string" ? message.agent : undefined,
      providerID,
      modelID,
      model: { providerID, modelID },
      finish: typeof message.finish === "string" ? message.finish : undefined,
      error: message.error,
      tokens: adaptTokens(message.tokens)
    },
    parts: [{ type: "step-start" }, ...content.map((part) => adaptAssistantPart(id, part))]
  };
}
function adaptAssistantPart(messageID, value) {
  const part = requireRecord(value, `assistant message ${messageID} content`);
  const type = requireString(part.type, `assistant message ${messageID} content type`);
  if (type === "text" || type === "reasoning") {
    return {
      type,
      text: typeof part.text === "string" ? part.text : ""
    };
  }
  if (type !== "tool")
    throw new Error(`Unsupported assistant content type: ${type}`);
  const state = requireRecord(part.state, `assistant tool ${String(part.id)} state`);
  const status = requireToolStatus(state.status);
  const input = status === "streaming" ? String(state.input ?? "") : isRecord(state.input) ? state.input : {};
  return {
    type: "tool",
    callID: requireString(part.id, "assistant tool id"),
    tool: requireString(part.name, "assistant tool name"),
    executed: part.executed === true,
    state: {
      status,
      input,
      ...status === "completed" ? { output: toolOutput(state.content) } : {},
      ...status === "error" ? { error: state.error } : {}
    }
  };
}
function compaction(sessionID, id, created, message) {
  const status = requireString(message.status, `compaction message ${id} status`);
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      sourceType: "compaction",
      summary: true,
      finish: status === "completed" ? "stop" : undefined,
      error: status === "failed" ? message.error : undefined,
      time: { created, ...status === "completed" ? { completed: created } : {} }
    },
    parts: [
      {
        type: "compaction",
        summary: typeof message.summary === "string" ? message.summary : undefined
      }
    ]
  };
}
function system(sessionID, id, created, sourceType, text) {
  return {
    info: { id, sessionID, role: "system", sourceType, time: { created } },
    parts: text ? [{ type: "text", text }] : []
  };
}
function adaptTokens(value) {
  if (!isRecord(value))
    return;
  const cache = isRecord(value.cache) ? value.cache : {};
  return {
    input: numberOrZero(value.input),
    output: numberOrZero(value.output),
    reasoning: numberOrZero(value.reasoning),
    cache: { read: numberOrZero(cache.read), write: numberOrZero(cache.write) }
  };
}
function toolOutput(value) {
  if (!Array.isArray(value))
    return value;
  if (value.length === 1 && isRecord(value[0]) && value[0].type === "text" && typeof value[0].text === "string") {
    return value[0].text;
  }
  return value;
}
function requireToolStatus(value) {
  if (value === "streaming" || value === "running" || value === "completed" || value === "error")
    return value;
  throw new Error(`Unsupported assistant tool state: ${String(value)}`);
}
function requireRecord(value, label) {
  if (!isRecord(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Invalid ${label}`);
  return value;
}
function requireNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// lib/sdk/client.ts
function pluginClient(session) {
  return { kind: "promise-plugin", selections: new Map, session };
}
function setSessionSelection(client, sessionID, selection) {
  client.selections.set(sessionID, selection);
}
function isAdaptedTranscript(values) {
  return values.every((value) => typeof value === "object" && value !== null && ("info" in value) && ("parts" in value));
}
async function listSessionMessages(client, sessionId) {
  const values = await client.session.context({ sessionID: sessionId });
  if (isAdaptedTranscript(values))
    return values;
  return adaptProjectedMessages(sessionId, values, client.selections.get(sessionId));
}
async function promptSession(client, input) {
  const text = input.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(`

`);
  if (!text)
    throw new Error("Session prompt requires text");
  if (input.noReply) {
    return client.session.synthetic({
      sessionID: input.sessionId,
      id: input.messageId,
      text,
      description: text,
      metadata: { "opencode.context-compress.ignored": true },
      resume: false
    });
  }
  return client.session.prompt({
    sessionID: input.sessionId,
    text,
    id: input.messageId,
    delivery: "steer",
    resume: true
  });
}

// lib/state/persistence.ts
import * as fs from "fs/promises";
import { existsSync as existsSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
var STORAGE_DIR = join2(process.env.XDG_DATA_HOME || join2(homedir2(), ".local", "share"), "opencode", "storage", "plugin", "compress");
var LEGACY_STORAGE_DIR = join2(process.env.XDG_DATA_HOME || join2(homedir2(), ".local", "share"), "opencode", "storage", "plugin", "dcp");
async function ensureStorageDir() {
  if (!existsSync2(STORAGE_DIR)) {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  }
}
async function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let tempFileCreated = false;
  try {
    const handle = await fs.open(tempPath, "w");
    tempFileCreated = true;
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    tempFileCreated = false;
  } finally {
    if (tempFileCreated) {
      await fs.rm(tempPath, { force: true }).catch(() => {
        return;
      });
    }
  }
}
async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return {
      status: "loaded",
      data: JSON.parse(content)
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
function getSessionFilePath(sessionId) {
  return join2(STORAGE_DIR, `${sessionId}.json`);
}
function getLegacySessionFilePath(sessionId) {
  return join2(LEGACY_STORAGE_DIR, `${sessionId}.json`);
}
function remapLegacyState(legacy) {
  return {
    sessionName: legacy.sessionName,
    compressed: {
      toolIds: legacy.prune?.toolIds ?? [],
      messageIds: legacy.prune?.messageIds ?? []
    },
    compressSummaries: legacy.compressSummaries ?? [],
    managementTurns: [],
    lastUpdated: legacy.lastUpdated
  };
}
function normalizeManagementTurns(turns) {
  if (!Array.isArray(turns)) {
    return [];
  }
  const normalized = [];
  const seen = new Set;
  for (const turn of turns) {
    if (!turn || typeof turn.triggerMessageId !== "string" || turn.triggerMessageId.length === 0) {
      continue;
    }
    if (seen.has(turn.triggerMessageId)) {
      continue;
    }
    seen.add(turn.triggerMessageId);
    normalized.push({
      triggerMessageId: turn.triggerMessageId,
      ...turn.cleanupVersion === 2 ? { cleanupVersion: 2 } : {},
      ...typeof turn.retainedText === "string" && turn.retainedText.length > 0 ? { retainedText: turn.retainedText } : {},
      ...typeof turn.completedAt === "string" && turn.completedAt.length > 0 ? { completedAt: turn.completedAt } : {},
      ...typeof turn.completedMessageId === "string" && turn.completedMessageId.length > 0 ? { completedMessageId: turn.completedMessageId } : {},
      ...turn.source === "automatic" || turn.source === "squash" ? { source: turn.source } : {},
      ...typeof turn.triggeredByMessageId === "string" && turn.triggeredByMessageId.length > 0 ? { triggeredByMessageId: turn.triggeredByMessageId } : {},
      ...Array.isArray(turn.protectedMessageIds) ? {
        protectedMessageIds: [
          ...new Set(turn.protectedMessageIds.filter((messageId) => typeof messageId === "string" && messageId.length > 0))
        ]
      } : {},
      ...typeof turn.contextTokens === "number" && Number.isFinite(turn.contextTokens) ? { contextTokens: turn.contextTokens } : {},
      ...typeof turn.thresholdTokens === "number" && Number.isFinite(turn.thresholdTokens) ? { thresholdTokens: turn.thresholdTokens } : {}
    });
  }
  return normalized;
}
function backfillCompressSummaryMessageIds(summaries, messages, compressedMessageIds) {
  return summaries.map((summary) => {
    if (Array.isArray(summary.messageIds) && summary.messageIds.length > 0) {
      return {
        anchorMessageId: summary.anchorMessageId,
        messageIds: [...new Set(summary.messageIds)],
        summary: summary.summary,
        ...summary.topic && { topic: summary.topic }
      };
    }
    const anchorIndex = messages.findIndex((msg) => msg.info.id === summary.anchorMessageId);
    const messageIds = [];
    if (anchorIndex !== -1 && compressedMessageIds.has(summary.anchorMessageId)) {
      for (let i = anchorIndex;i < messages.length; i++) {
        const messageId = messages[i].info.id;
        if (!compressedMessageIds.has(messageId)) {
          break;
        }
        if (!messageIds.includes(messageId)) {
          messageIds.push(messageId);
        }
      }
    }
    if (messageIds.length === 0) {
      messageIds.push(summary.anchorMessageId);
    }
    return {
      anchorMessageId: summary.anchorMessageId,
      messageIds,
      summary: summary.summary,
      ...summary.topic && { topic: summary.topic }
    };
  });
}
async function saveSessionState(sessionState, logger, sessionName) {
  try {
    if (!sessionState.sessionId) {
      return false;
    }
    await ensureStorageDir();
    const lastUpdated = new Date().toISOString();
    const state = {
      sessionName,
      compressed: {
        toolIds: [...sessionState.compressed.toolIds],
        messageIds: [...sessionState.compressed.messageIds]
      },
      ...sessionState.anthropicStubIds ? { anthropicStubIds: [...sessionState.anthropicStubIds] } : {},
      compressSummaries: sessionState.compressSummaries,
      managementTurns: sessionState.managementTurns,
      ...sessionState.pruneOff ? { pruneOff: true } : {},
      ...sessionState.lastCompaction > 0 ? { lastCompaction: sessionState.lastCompaction } : {},
      lastUpdated
    };
    const filePath = getSessionFilePath(sessionState.sessionId);
    const content = JSON.stringify({ ...state, stats: {} }, null, 2);
    await writeFileAtomic(filePath, content);
    sessionState.hasPersistedState = true;
    sessionState.persistedLastUpdated = lastUpdated;
    return true;
  } catch (error) {
    logger.error("Failed to save session state", {
      sessionId: sessionState.sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}
async function loadSessionState(sessionId, logger, messages) {
  const filePath = getSessionFilePath(sessionId);
  const primaryResult = await readJsonFile(filePath);
  let state;
  let migrated = false;
  if (primaryResult.status === "loaded") {
    state = primaryResult.data;
  } else if (primaryResult.status === "error") {
    logger.warn("Failed to load session state", {
      sessionId,
      path: filePath,
      error: primaryResult.error
    });
    return { status: "error" };
  } else {
    const legacyPath = getLegacySessionFilePath(sessionId);
    const legacyResult = await readJsonFile(legacyPath);
    if (legacyResult.status === "missing") {
      return { status: "missing" };
    }
    if (legacyResult.status === "error") {
      logger.warn("Failed to load legacy session state", {
        sessionId,
        path: legacyPath,
        error: legacyResult.error
      });
      return { status: "error" };
    }
    logger.info("Found legacy state file, migrating", { sessionId });
    state = remapLegacyState(legacyResult.data);
    migrated = true;
  }
  if (!state?.compressed || !Array.isArray(state.compressed.toolIds)) {
    logger.warn("Invalid session state file, preserving in-memory state", {
      sessionId,
      path: migrated ? getLegacySessionFilePath(sessionId) : filePath
    });
    return { status: "error" };
  }
  if (!Array.isArray(state.compressed.messageIds)) {
    state.compressed.messageIds = [];
  }
  let compressSummaries = [];
  if (Array.isArray(state.compressSummaries)) {
    const validSummaries = state.compressSummaries.filter((s) => s !== null && typeof s === "object" && typeof s.anchorMessageId === "string" && typeof s.summary === "string" && (s.messageIds === undefined || Array.isArray(s.messageIds) && s.messageIds.every((messageId) => typeof messageId === "string")));
    if (validSummaries.length !== state.compressSummaries.length) {
      logger.warn("Filtered out malformed compressSummaries entries", {
        sessionId,
        original: state.compressSummaries.length,
        valid: validSummaries.length
      });
    }
    if (messages) {
      compressSummaries = backfillCompressSummaryMessageIds(validSummaries, messages, new Set(state.compressed.messageIds));
    } else {
      compressSummaries = validSummaries.map((summary) => ({
        anchorMessageId: summary.anchorMessageId,
        messageIds: Array.isArray(summary.messageIds) && summary.messageIds.length > 0 ? [...new Set(summary.messageIds)] : [summary.anchorMessageId],
        summary: summary.summary,
        ...summary.topic && { topic: summary.topic }
      }));
    }
  }
  const managementTurns = normalizeManagementTurns(state.managementTurns);
  const result = {
    sessionName: state.sessionName,
    compressed: state.compressed,
    ...Array.isArray(state.anthropicStubIds) ? { anthropicStubIds: state.anthropicStubIds } : {},
    compressSummaries,
    managementTurns,
    ...state.pruneOff === true ? { pruneOff: true } : {},
    ...typeof state.lastCompaction === "number" && Number.isFinite(state.lastCompaction) && state.lastCompaction > 0 ? { lastCompaction: state.lastCompaction } : {},
    lastUpdated: state.lastUpdated
  };
  if (migrated) {
    try {
      await ensureStorageDir();
      const newFilePath = getSessionFilePath(sessionId);
      await writeFileAtomic(newFilePath, JSON.stringify(result, null, 2));
      logger.info("Migrated legacy state to compress path", { sessionId });
    } catch (saveError) {
      logger.warn("Failed to save migrated state (will retry next load)", {
        sessionId,
        error: saveError instanceof Error ? saveError.message : String(saveError)
      });
    }
  }
  return {
    status: "loaded",
    state: result
  };
}
// lib/state/utils.ts
function isCompletedNativeCompaction(message) {
  const info = message.info;
  return info.role === "assistant" && info.summary === true && !!info.finish && !info.error;
}
function findLastCompactionTimestamp(messages) {
  for (let i = messages.length - 1;i >= 0; i--) {
    const msg = messages[i];
    if (isCompletedNativeCompaction(msg)) {
      return msg.info.time.created;
    }
  }
  return 0;
}
function resetOnCompaction(state) {
  state.compressed.toolIds = new Set;
  state.compressed.messageIds = new Set;
  state.compressSummaries = [];
  state.managementTurns = [];
}

// lib/state/state.ts
function commitDurableSessionState(state, candidate) {
  state.compressed = candidate.compressed;
  state.anthropicStubIds = candidate.anthropicStubIds;
  state.compressSummaries = candidate.compressSummaries;
  state.managementTurns = candidate.managementTurns;
  state.pruneOff = candidate.pruneOff;
  state.lastCompaction = candidate.lastCompaction;
  state.hasPersistedState = candidate.hasPersistedState;
  state.persistedLastUpdated = candidate.persistedLastUpdated;
}
function applyPersistedState(state, persisted) {
  if (persisted?.status !== "loaded") {
    return;
  }
  const persistedState = persisted.state;
  state.compressed = {
    toolIds: new Set(persistedState.compressed.toolIds || []),
    messageIds: new Set(persistedState.compressed.messageIds || [])
  };
  state.anthropicStubIds = persistedState.anthropicStubIds && new Set(persistedState.anthropicStubIds);
  state.compressSummaries = persistedState.compressSummaries || [];
  state.managementTurns = persistedState.managementTurns || [];
  state.pruneOff = persistedState.pruneOff;
  state.lastCompaction = persistedState.lastCompaction ?? 0;
  state.hasPersistedState = true;
  state.persistedLastUpdated = persistedState.lastUpdated || null;
}
function clearPersistedCompressionState(state) {
  state.compressed = {
    toolIds: new Set,
    messageIds: new Set
  };
  state.compressSummaries = [];
  state.managementTurns = [];
  state.lastCompaction = 0;
  state.hasPersistedState = false;
  state.persistedLastUpdated = null;
}
async function refreshPersistedSessionState(state, sessionId, logger, messages) {
  const persisted = await loadSessionState(sessionId, logger, messages);
  if (persisted.status === "missing") {
    state.persistenceSynchronized = true;
    if (state.hasPersistedState) {
      clearPersistedCompressionState(state);
      return {
        source: "disk-cleared",
        lastUpdated: null
      };
    }
    return {
      source: "memory",
      lastUpdated: state.persistedLastUpdated
    };
  }
  if (persisted.status === "error") {
    state.persistenceSynchronized = false;
    return {
      source: "memory",
      lastUpdated: state.persistedLastUpdated
    };
  }
  state.persistenceSynchronized = true;
  if (!state.hasPersistedState) {
    applyPersistedState(state, persisted);
    return {
      source: "disk-load",
      lastUpdated: state.persistedLastUpdated
    };
  }
  if (state.persistedLastUpdated !== persisted.state.lastUpdated) {
    applyPersistedState(state, persisted);
    return {
      source: "disk-reload",
      lastUpdated: state.persistedLastUpdated
    };
  }
  return {
    source: "memory",
    lastUpdated: state.persistedLastUpdated
  };
}
function findLastCompactionIndex(messages) {
  for (let index = messages.length - 1;index >= 0; index--) {
    const message = messages[index];
    if (isCompletedNativeCompaction(message)) {
      return index;
    }
  }
  return -1;
}
function getCompressionStateCompactionOrder(state, messages, compactionIndex) {
  const referencedMessageIds = new Set(state.compressed.messageIds);
  for (const summary of state.compressSummaries) {
    referencedMessageIds.add(summary.anchorMessageId);
    for (const messageId of summary.messageIds)
      referencedMessageIds.add(messageId);
  }
  for (const turn of state.managementTurns) {
    referencedMessageIds.add(turn.triggerMessageId);
    if (turn.completedMessageId)
      referencedMessageIds.add(turn.completedMessageId);
  }
  const hasCompressionState = referencedMessageIds.size > 0 || state.compressed.toolIds.size > 0 || state.compressSummaries.length > 0 || state.managementTurns.length > 0;
  if (!hasCompressionState)
    return "after";
  if (referencedMessageIds.size === 0)
    return "unknown";
  const indexByMessageId = new Map(messages.map((message, index) => [message.info.id, index]));
  let missingReference = false;
  for (const messageId of referencedMessageIds) {
    const messageIndex = indexByMessageId.get(messageId);
    if (messageIndex === undefined) {
      missingReference = true;
    } else if (messageIndex < compactionIndex) {
      return "before";
    }
  }
  return missingReference ? "unknown" : "after";
}
async function reconcileSessionLifecycle(state, sessionId, logger, messages) {
  const syncResult = await ensureSessionInitialized(state, sessionId, logger, messages);
  if (!state.persistenceSynchronized)
    return syncResult;
  const compactionTimestamp = findLastCompactionTimestamp(messages);
  const compactionIndex = findLastCompactionIndex(messages);
  const compactionOrder = compactionIndex === -1 ? "after" : getCompressionStateCompactionOrder(state, messages, compactionIndex);
  const unresolvedNewCompaction = compactionTimestamp > state.lastCompaction;
  const requiresCompactionReset = compactionIndex !== -1 && (compactionOrder === "before" || compactionOrder === "unknown" && unresolvedNewCompaction);
  if (requiresCompactionReset || unresolvedNewCompaction) {
    const candidate = {
      ...state,
      ...requiresCompactionReset ? {
        compressed: {
          toolIds: new Set,
          messageIds: new Set
        },
        compressSummaries: [],
        managementTurns: []
      } : {},
      ...unresolvedNewCompaction ? { lastCompaction: compactionTimestamp } : {}
    };
    const persisted = await saveSessionState(candidate, logger);
    if (!persisted) {
      state.persistenceSynchronized = false;
      return syncResult;
    }
    commitDurableSessionState(state, candidate);
    if (requiresCompactionReset) {
      resetOnCompaction(state);
      logger.info("Reconciled native compaction against durable compression state", {
        timestamp: compactionTimestamp
      });
    }
  }
  const present = new Set(messages.map((message) => message.info.id));
  const stale = state.compressSummaries.filter((summary) => cutByRewind(summary, present));
  if (stale.length === 0)
    return syncResult;
  const dropped = new Set(stale.flatMap((summary) => [summary.anchorMessageId, ...summary.messageIds]));
  const droppedTools = new Set(messages.filter((message) => dropped.has(message.info.id)).flatMap((message) => message.parts.flatMap((part) => part.type === "tool" ? [part.callID] : [])));
  const candidate = {
    ...state,
    compressed: {
      messageIds: new Set([...state.compressed.messageIds].filter((id) => !dropped.has(id))),
      toolIds: new Set([...state.compressed.toolIds].filter((id) => !droppedTools.has(id)))
    },
    anthropicStubIds: state.anthropicStubIds && new Set([...state.anthropicStubIds].filter((id) => !droppedTools.has(id))),
    compressSummaries: state.compressSummaries.filter((summary) => !stale.includes(summary))
  };
  if (!await saveSessionState(candidate, logger)) {
    state.persistenceSynchronized = false;
    return syncResult;
  }
  commitDurableSessionState(state, candidate);
  logger.info("Dropped compression blocks for rewound messages", { blocks: stale.length });
  return syncResult;
}
function cutByRewind(summary, present) {
  const cut = summary.messageIds.findIndex((id) => !present.has(id));
  if (cut < 0)
    return false;
  if (summary.messageIds.slice(cut).some((id) => present.has(id)))
    return false;
  return present.has(summary.anchorMessageId) === cut > 0;
}

class SessionStateManager {
  sessions = new Map;
  mutationTails = new Map;
  get(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = createSessionState();
      state.sessionId = sessionId;
      this.sessions.set(sessionId, state);
    }
    return state;
  }
  has(sessionId) {
    return this.sessions.has(sessionId);
  }
  delete(sessionId) {
    this.sessions.delete(sessionId);
    this.mutationTails.delete(sessionId);
  }
  size() {
    return this.sessions.size;
  }
  async runExclusive(sessionId, operation) {
    const previous = this.mutationTails.get(sessionId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.mutationTails.set(sessionId, tail);
    await previous.catch(() => {
      return;
    });
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(sessionId) === tail) {
        this.mutationTails.delete(sessionId);
      }
    }
  }
}
var checkSession = async (state, logger, messages) => {
  if (!state.sessionId) {
    return {
      source: "memory",
      lastUpdated: null
    };
  }
  const unreconciled = {
    source: "memory",
    lastUpdated: state.persistedLastUpdated
  };
  try {
    return await reconcileSessionLifecycle(state, state.sessionId, logger, messages);
  } catch (err) {
    logger.error("Failed to initialize session state", {
      error: err instanceof Error ? err.message : String(err)
    });
    return unreconciled;
  }
};
function createSessionState() {
  return {
    sessionId: null,
    initialized: false,
    persistenceSynchronized: false,
    hasPersistedState: false,
    persistedLastUpdated: null,
    compressed: {
      toolIds: new Set,
      messageIds: new Set
    },
    compressSummaries: [],
    managementTurns: [],
    lastCompaction: 0
  };
}
async function ensureSessionInitialized(state, sessionId, logger, messages) {
  if (state.sessionId && state.sessionId !== sessionId) {
    throw new Error(`Session state mismatch: existing=${state.sessionId}, requested=${sessionId}`);
  }
  state.sessionId = sessionId;
  state.initialized = true;
  return await refreshPersistedSessionState(state, sessionId, logger, messages);
}
// lib/ui/notification.ts
async function sendIgnoredMessage(client, sessionID, text, logger) {
  try {
    await promptSession(client, {
      sessionId: sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text,
          ignored: true
        }
      ]
    });
  } catch (error) {
    logger.error("Failed to send notification", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// lib/ui/utils.ts
function formatTokenCount(tokens) {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K tokens`;
  }
  return `${tokens} tokens`;
}

// lib/token-utils.ts
import { countTokens as anthropicCountTokens } from "@anthropic-ai/tokenizer";
import { encodingForModel } from "js-tiktoken";
var _tiktokenEncoder = null;
function getTiktokenEncoder() {
  if (!_tiktokenEncoder) {
    _tiktokenEncoder = encodingForModel("gpt-4o");
  }
  return _tiktokenEncoder;
}
function isAnthropicProvider(providerId) {
  if (!providerId)
    return false;
  return providerId.toLowerCase().includes("anthropic");
}
function getCurrentProviderId(state, messages) {
  return getLastUserMessage(messages)?.info.model?.providerID ?? state.modelContext?.providerId;
}
function countTokens(text, providerId) {
  if (!text)
    return 0;
  try {
    if (isAnthropicProvider(providerId)) {
      return anthropicCountTokens(text);
    }
    return getTiktokenEncoder().encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

// lib/commands/context.ts
function analyzeTokens(state, messages, providerId) {
  const breakdown = {
    system: 0,
    user: 0,
    assistant: 0,
    tools: 0,
    toolCount: 0,
    compressedToolCount: state.compressed.toolIds.size,
    total: 0
  };
  let firstAssistant;
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      if ((msg.info.tokens?.input ?? 0) > 0 || (msg.info.tokens?.cache?.read ?? 0) > 0) {
        firstAssistant = msg.info;
        break;
      }
    }
  }
  let lastAssistant;
  for (let i = messages.length - 1;i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "assistant") {
      if ((msg.info.tokens?.output ?? 0) > 0) {
        lastAssistant = msg.info;
        break;
      }
    }
  }
  const apiInput = lastAssistant?.tokens?.input || 0;
  const apiOutput = lastAssistant?.tokens?.output || 0;
  const apiReasoning = lastAssistant?.tokens?.reasoning || 0;
  const apiCacheRead = lastAssistant?.tokens?.cache?.read || 0;
  const apiCacheWrite = lastAssistant?.tokens?.cache?.write || 0;
  breakdown.total = apiInput + apiOutput + apiReasoning + apiCacheRead + apiCacheWrite;
  const userTextParts = [];
  const toolInputParts = [];
  const toolOutputParts = [];
  let firstUserText = "";
  let foundFirstUser = false;
  const foundToolIds = new Set;
  for (const msg of messages) {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const isCompacted = isMessageCompacted(state, msg);
    const isIgnoredUser = msg.info.role === "user" && isIgnoredUserMessage(msg);
    for (const part of parts) {
      if (part.type === "tool") {
        const toolPart = part;
        if (toolPart.callID && !foundToolIds.has(toolPart.callID)) {
          breakdown.toolCount++;
          foundToolIds.add(toolPart.callID);
        }
        const isCompressed = toolPart.callID && state.compressed.toolIds.has(toolPart.callID);
        if (!isCompacted && !isCompressed) {
          if (toolPart.state?.input) {
            const inputStr = typeof toolPart.state.input === "string" ? toolPart.state.input : JSON.stringify(toolPart.state.input);
            toolInputParts.push(inputStr);
          }
          if (toolPart.state?.status === "completed" && toolPart.state?.output) {
            const outputStr = typeof toolPart.state.output === "string" ? toolPart.state.output : JSON.stringify(toolPart.state.output);
            toolOutputParts.push(outputStr);
          }
        }
      } else if (part.type === "text" && msg.info.role === "user" && !isCompacted && !isIgnoredUser) {
        const textPart = part;
        const text = textPart.text || "";
        userTextParts.push(text);
        if (!foundFirstUser) {
          firstUserText += text;
        }
      }
    }
    if (msg.info.role === "user" && !isIgnoredUser && !foundFirstUser) {
      foundFirstUser = true;
    }
  }
  const firstUserTokens = countTokens(firstUserText, providerId);
  breakdown.user = countTokens(userTextParts.join(`
`), providerId);
  const toolInputTokens = countTokens(toolInputParts.join(`
`), providerId);
  const toolOutputTokens = countTokens(toolOutputParts.join(`
`), providerId);
  if (firstAssistant) {
    const firstInput = (firstAssistant.tokens?.input || 0) + (firstAssistant.tokens?.cache?.read || 0);
    breakdown.system = Math.max(0, firstInput - firstUserTokens);
  }
  breakdown.tools = toolInputTokens + toolOutputTokens;
  breakdown.assistant = Math.max(0, breakdown.total - breakdown.system - breakdown.user - breakdown.tools);
  return breakdown;
}
function createBar(value, maxValue, width, char = "\u2588") {
  if (maxValue === 0)
    return "";
  const filled = Math.round(value / maxValue * width);
  const bar = char.repeat(Math.max(0, filled));
  return bar;
}
function formatContextMessage(breakdown) {
  const lines = [];
  const barWidth = 30;
  const toolsInContext = breakdown.toolCount - breakdown.compressedToolCount;
  const toolsLabel = `Tools (${toolsInContext})`;
  const categories = [
    { label: "System", value: breakdown.system, char: "\u2588" },
    { label: "User", value: breakdown.user, char: "\u2593" },
    { label: "Assistant", value: breakdown.assistant, char: "\u2592" },
    { label: toolsLabel, value: breakdown.tools, char: "\u2591" }
  ];
  const maxLabelLen = Math.max(...categories.map((c) => c.label.length));
  lines.push("\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E");
  lines.push("\u2502               Compress Context Analysis                   \u2502");
  lines.push("\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F");
  lines.push("");
  lines.push("Session Context Breakdown:");
  lines.push("\u2500".repeat(60));
  lines.push("");
  for (const cat of categories) {
    const bar = createBar(cat.value, breakdown.total, barWidth, cat.char);
    const percentage = breakdown.total > 0 ? (cat.value / breakdown.total * 100).toFixed(1) : "0.0";
    const labelWithPct = `${cat.label.padEnd(maxLabelLen)} ${percentage.padStart(5)}% `;
    const valueStr = formatTokenCount(cat.value).padStart(13);
    lines.push(`${labelWithPct}\u2502${bar.padEnd(barWidth)}\u2502${valueStr}`);
  }
  lines.push("");
  lines.push("\u2500".repeat(60));
  lines.push("");
  lines.push("Summary:");
  lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`);
  lines.push("");
  return lines.join(`
`);
}
async function handleContextCommand(ctx) {
  const { client, state, logger, sessionId, messages } = ctx;
  const breakdown = analyzeTokens(state, messages, getCurrentProviderId(state, messages));
  const message = formatContextMessage(breakdown);
  await sendIgnoredMessage(client, sessionId, message, logger);
}

// lib/commands/help.ts
function formatHelpMessage() {
  const lines = [];
  lines.push("**Compress commands**");
  lines.push("");
  lines.push("- `/compress context` \u2014 Show token usage breakdown for current session");
  lines.push("- `/compress manage [instruction]` \u2014 Ask the agent to fold the context now, optionally with your guidance for the summary");
  lines.push("- `/compress prune [status|on|off]` \u2014 Pause or resume background pruning for this session; pruned outputs stay pruned");
  lines.push("- `/compress help` \u2014 Show this command list");
  return lines.join(`
`);
}
async function handleHelpCommand(ctx) {
  const { client, logger, sessionId } = ctx;
  const message = formatHelpMessage();
  await sendIgnoredMessage(client, sessionId, message, logger);
}

// lib/prompts/_codegen/fold-documentation.generated.ts
var FOLD_DOCUMENTATION = `2. Update the project's documentation with the \`librarian\` and \`librarian-audit\` skills. Documentation is the long-lived memory; decisions, verified findings, and open questions that exist only in this conversation are lost unless it holds them. Skip this if it is current, the user asked for no edits, or you cannot write.
`;

// lib/prompts/_codegen/fold-documentation-subagent.generated.ts
var FOLD_DOCUMENTATION_SUBAGENT = `2. Do not edit documentation: the session that briefed you owns it, unless your brief made it your task. Put decisions, verified findings, and open questions under \`For the parent\` in the summary. Keep your brief's task, boundaries, and completion criteria there too, because the brief disappears with the fold.
   If your final report is already written, skip the fold and send that report again in full as your last message, because the parent receives only your last message.
`;

// lib/prompts/_codegen/fold-request.generated.ts
var FOLD_REQUEST = `<system-reminder>
CONTEXT FOLD REQUESTED
{{reason}} It is due, not urgent, and not a change of task.

A fold replaces this whole conversation with one summary that you write. Nothing else stays visible. Project instructions (AGENTS.md, skills) load fresh afterwards; files and running jobs are untouched.

If a \`<user-message>\` block follows, it is the user's guidance for this fold.

In order:
1. Reach a clean stopping point: finish and verify the current step, leave nothing half-done, start no new large work.
{{documentation}}
3. Call \`compress\` once with the summary before this turn ends. Until you do, this request repeats and the context keeps growing.

Summary: what a capable colleague needs to take over right now, in English, as short as the live state allows.
- Request: the user's goal and newest request, quoted where the wording matters.
- Decisions and limits: what the user decided or ruled out, apart from your own assumptions.
- State: done and verified (with evidence), in progress, failed or uncertain.
- Next step: the next action, or that the work is finished or waiting. Name running jobs and subagents by ID.
- References: exact paths, commands, identifiers.
Leave out what instructions or documentation already say, history that no longer matters, and stale parts of an earlier summary. Never invent facts or completion.

After the fold, continue active work from the summary without announcing it; leave finished or waiting work alone. If the call fails, report the error and do not retry.
</system-reminder>
`;

// lib/prompts/_codegen/compress.generated.ts
var COMPRESS = `Replaces the whole conversation so far with the summary you pass, right after the current step. Call it only when the user asked for compression in the current turn or a fold request from the plugin is part of this turn. High context usage, tool availability, or your own judgment is not a reason: a fold discards everything that is not in the summary or in the project's documentation.

Before calling, bring the work to a clean stopping point and update the project's documentation as the fold request describes; the documentation is the long-lived memory and the summary only a note about the work in progress.

\`summary\`: what a capable colleague would need to take over this exact work right now, in English. Cover the user's goal and newest request; the user's decisions and limits, apart from your assumptions; what is done with its evidence, what is in progress, and what is uncertain; the next concrete action, or that the work is finished or waiting for the user; running jobs and subagents with their IDs; and the exact paths, commands, and identifiers needed to continue. Leave out what the project's instructions or documentation already say, history that no longer affects the next step, and stale parts of an earlier summary, which is replaced too. Never invent facts or completion.

Call it once. After success, continue active, authorized work from the summary without reopening finished work. A failure means nothing was folded: report the exact error and do not retry by yourself.
`;

// lib/prompts/index.ts
function renderFoldRequest(reason, subagent) {
  const documentation = subagent ? FOLD_DOCUMENTATION_SUBAGENT : FOLD_DOCUMENTATION;
  return FOLD_REQUEST.trim().replace("{{reason}}", () => reason).replace("{{documentation}}", () => documentation.trim());
}

// lib/commands/manage.ts
async function handleManageCommand(ctx) {
  if (ctx.config.tools.compress.permission === "deny") {
    await sendIgnoredMessage(ctx.client, ctx.sessionId, "The fold request was not sent because compress is denied. Enable the compress tool, then run `/compress manage` again.", ctx.logger);
    return;
  }
  const instruction = ctx.arguments.trim().replace(/^manage\b/i, "").trim();
  const session = await ctx.client.session.get({ sessionID: ctx.sessionId });
  await promptSession(ctx.client, {
    sessionId: ctx.sessionId,
    parts: [
      {
        type: "text",
        text: renderFoldRequest("The user ran `/compress manage`.", session.parentID !== undefined)
      },
      ...instruction ? [{ type: "text", text: `<user-message>
${instruction}
</user-message>` }] : []
    ]
  }).then(() => ctx.logger.info("Fold request sent", { sessionId: ctx.sessionId, source: "manual" }), async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error("Fold request failed", { sessionId: ctx.sessionId, error: message });
    await sendIgnoredMessage(ctx.client, ctx.sessionId, `Could not send the fold request: ${message}`, ctx.logger);
  });
}

// lib/commands/prune.ts
var PRUNE_USAGE = "Usage: `/compress prune [status|on|off]`";
async function handlePruneCommand(ctx) {
  const action = ctx.arguments.length <= 1 ? ctx.arguments[0]?.toLowerCase() ?? "status" : "";
  const response = ["status", "on", "off"].includes(action) ? await ctx.stateManager.runExclusive(ctx.sessionId, async () => {
    const messages = await listSessionMessages(ctx.client, ctx.sessionId);
    await reconcileSessionLifecycle(ctx.state, ctx.sessionId, ctx.logger, messages);
    if (!ctx.state.persistenceSynchronized)
      return "Pruning settings are unavailable because saved session state could not be loaded. Nothing was changed.";
    const off = ctx.state.pruneOff === true;
    if (action === "status")
      return `Background pruning is ${off ? "off" : "on"} for this session.`;
    if (action === "off" === off)
      return `Background pruning is already ${action} for this session.`;
    const candidate = {
      ...ctx.state,
      pruneOff: action === "off" ? true : undefined
    };
    if (!await saveSessionState(candidate, ctx.logger))
      return "Pruning settings could not be saved. Nothing was changed.";
    commitDurableSessionState(ctx.state, candidate);
    return action === "off" ? "Background pruning is off for this session. Outputs pruned so far stay pruned." : "Background pruning is on for this session.";
  }) : PRUNE_USAGE;
  await sendIgnoredMessage(ctx.client, ctx.sessionId, response, ctx.logger);
}

// lib/commands/route.ts
async function handleCompressCommand(input, dependencies) {
  if (!dependencies.config.commands.enabled || input.command !== "compress")
    return false;
  const { client, stateManager, logger, config } = dependencies;
  const state = stateManager.get(input.sessionID);
  const messages = await stateManager.runExclusive(input.sessionID, async () => {
    const currentMessages = await listSessionMessages(client, input.sessionID);
    await reconcileSessionLifecycle(state, input.sessionID, logger, currentMessages);
    return currentMessages;
  });
  const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean);
  const subcommand = args[0]?.toLowerCase() || "";
  if (subcommand === "context") {
    await handleContextCommand({ client, state, logger, sessionId: input.sessionID, messages });
    return true;
  }
  if (subcommand === "manage") {
    await handleManageCommand({
      client,
      config,
      logger,
      sessionId: input.sessionID,
      arguments: input.arguments
    });
    return true;
  }
  if (subcommand === "prune") {
    await handlePruneCommand({
      client,
      stateManager,
      state,
      logger,
      sessionId: input.sessionID,
      arguments: args.slice(1)
    });
    return true;
  }
  await handleHelpCommand({ client, logger, sessionId: input.sessionID });
  return true;
}

// lib/fold-request.ts
import { createHash as createHash2 } from "crypto";
var REPEAT_TOKENS = 1e5;
function createFoldRequestHandler(client, stateManager, logger, config, pending, acceptsSession) {
  const levels = new Map;
  const undelivered = new Map;
  return async (input) => {
    const event = isRecord(input) ? input : {};
    const data = isRecord(event.data) ? event.data : {};
    const sessionID = data.sessionID;
    if (typeof sessionID !== "string")
      return;
    if ((event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") && data.inboxID === undelivered.get(sessionID))
      undelivered.delete(sessionID);
    if (event.type !== "session.step.ended")
      return;
    if (typeof data.assistantMessageID !== "string" || typeof event.created !== "number")
      return;
    if (!config.autoCompression.enabled || config.tools.compress.permission === "deny")
      return;
    if (pending.has(sessionID))
      return;
    const tokens = isRecord(data.tokens) ? data.tokens : {};
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    const contextTokens = [
      tokens.input,
      tokens.output,
      tokens.reasoning,
      cache.read,
      cache.write
    ].reduce((sum, value) => sum + (typeof value === "number" && value > 0 ? value : 0), 0);
    const tokenThreshold = config.autoCompression.tokenThreshold;
    const contextLimit = stateManager.get(sessionID).modelContext?.contextLimit;
    const ratioThreshold = contextLimit ? Math.floor(contextLimit * config.autoCompression.contextWindowRatio) : undefined;
    const thresholdTokens = Math.min(ratioThreshold ?? tokenThreshold, tokenThreshold);
    const level = contextTokens < thresholdTokens ? 0 : Math.floor((contextTokens - thresholdTokens) / REPEAT_TOKENS) + 1;
    if (level > (levels.get(sessionID) ?? 0) && !undelivered.has(sessionID)) {
      if (!await acceptsSession(sessionID, event))
        return;
      const session = await client.session.get({ sessionID });
      if (session.parentID !== undefined && data.finish === "stop")
        return;
      const messageId = generateAutomaticPromptMessageId(sessionID, data.assistantMessageID, event.created);
      const number = (value) => value.toLocaleString("en-US");
      const basis = ratioThreshold !== undefined && ratioThreshold <= tokenThreshold ? `${Math.round(config.autoCompression.contextWindowRatio * 100)}% of the model-reported context window` : "the system-wide absolute token limit";
      await promptSession(client, {
        sessionId: sessionID,
        parts: [
          {
            type: "text",
            text: renderFoldRequest(`Working context reached ~${number(contextTokens)} tokens; the fold threshold is ~${number(thresholdTokens)} tokens (${basis}). The plugin sent this request automatically.`, session.parentID !== undefined)
          }
        ],
        messageId
      });
      undelivered.set(sessionID, messageId);
      logger.info("Fold request sent", {
        sessionId: sessionID,
        contextTokens,
        thresholdTokens
      });
    }
    if (level === 0)
      levels.delete(sessionID);
    else
      levels.set(sessionID, level);
  };
}
function generateAutomaticPromptMessageId(sessionId, triggerId, time) {
  const inverted = ~(BigInt(Math.floor(time)) * 0x1000n);
  const prefix = Array.from({ length: 6 }, (_, index) => Number(inverted >> BigInt(40 - 8 * index) & 0xffn).toString(16).padStart(2, "0")).join("");
  const identity = JSON.stringify(["automatic-compression", sessionId, triggerId]);
  return `msg_${prefix}${createHash2("sha256").update(identity).digest("hex").slice(0, 14)}`;
}

// lib/logger.ts
import { mkdir as mkdir2, readdir, rm as rm2, writeFile } from "fs/promises";
import { join as join3 } from "path";
import { existsSync as existsSync3 } from "fs";
import { homedir as homedir3 } from "os";
var DAILY_LOG_DAYS = 30;

class Logger {
  logDir;
  cleanedDay;
  dailyEnabled;
  contextEnabled;
  constructor(options) {
    this.dailyEnabled = options.daily;
    this.contextEnabled = options.context;
    const configHome = process.env.XDG_CONFIG_HOME || join3(homedir3(), ".config");
    this.logDir = join3(configHome, "opencode", "logs", "compress");
  }
  async ensureLogDir() {
    if (!existsSync3(this.logDir)) {
      await mkdir2(this.logDir, { recursive: true });
    }
  }
  formatData(data) {
    if (!data)
      return "";
    const parts = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null)
        continue;
      if (Array.isArray(value)) {
        if (value.length === 0)
          continue;
        parts.push(`${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`);
      } else if (typeof value === "object") {
        const str = JSON.stringify(value);
        if (str.length < 50) {
          parts.push(`${key}=${str}`);
        }
      } else {
        parts.push(`${key}=${value}`);
      }
    }
    return parts.join(" ");
  }
  getCallerFile(skipFrames = 3) {
    const originalPrepareStackTrace = Error.prepareStackTrace;
    try {
      const err = new Error;
      Error.prepareStackTrace = (_, stack) => stack;
      const stack = err.stack;
      Error.prepareStackTrace = originalPrepareStackTrace;
      for (let i = skipFrames;i < stack.length; i++) {
        const filename = stack[i]?.getFileName();
        if (filename && !filename.includes("/logger.")) {
          const match = filename.match(/([^/\\]+)\.[tj]s$/);
          return match ? match[1] : filename;
        }
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }
  async write(level, component, message, data) {
    if (!this.dailyEnabled)
      return;
    try {
      await this.ensureLogDir();
      const timestamp = new Date().toISOString();
      const dataStr = this.formatData(data);
      const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? ` | ${dataStr}` : ""}
`;
      const dailyLogDir = join3(this.logDir, "daily");
      if (!existsSync3(dailyLogDir)) {
        await mkdir2(dailyLogDir, { recursive: true });
      }
      const day = timestamp.split("T")[0];
      await writeFile(join3(dailyLogDir, `${day}.log`), logLine, { flag: "a" });
      if (this.cleanedDay !== day) {
        this.cleanedDay = day;
        const cutoff = new Date(Date.now() - DAILY_LOG_DAYS * 86400000).toISOString().split("T")[0];
        const old = (await readdir(dailyLogDir)).filter((name) => name.endsWith(".log") && name.slice(0, 10) < cutoff);
        await Promise.all(old.map((name) => rm2(join3(dailyLogDir, name), { force: true })));
      }
    } catch (error) {
      console.error("context-compress: failed to write daily log", error);
    }
  }
  info(message, data) {
    const component = this.getCallerFile(2);
    return this.write("INFO", component, message, data);
  }
  debug(message, data) {
    const component = this.getCallerFile(2);
    return this.write("DEBUG", component, message, data);
  }
  warn(message, data) {
    const component = this.getCallerFile(2);
    return this.write("WARN", component, message, data);
  }
  error(message, data) {
    const component = this.getCallerFile(2);
    return this.write("ERROR", component, message, data);
  }
  minimizeForDebug(messages) {
    return messages.map((message) => {
      const msg = isRecord(message) ? message : {};
      const info = isRecord(msg.info) ? msg.info : {};
      const time = isRecord(info.time) ? info.time : {};
      const minimized = {
        role: info.role ?? msg.role
      };
      if (time.created) {
        minimized.time = time.created;
      }
      if (isRecord(info.tokens)) {
        minimized.tokens = {
          input: info.tokens.input,
          output: info.tokens.output,
          reasoning: info.tokens.reasoning,
          cache: info.tokens.cache
        };
      }
      const parts = msg.parts ?? msg.content;
      if (Array.isArray(parts)) {
        minimized.parts = parts.map((item) => {
          const part = isRecord(item) ? item : {};
          if (part.type === "step-start" || part.type === "step-finish") {
            return null;
          }
          if (part.type === "text") {
            if (part.ignored)
              return null;
            return { type: "text", text: part.text };
          }
          if (part.type === "reasoning") {
            return {
              type: "reasoning",
              text: part.text
            };
          }
          if (part.type === "tool") {
            const state = isRecord(part.state) ? part.state : {};
            const toolPart = {
              type: "tool",
              tool: part.tool,
              callID: part.callID
            };
            if (state.status) {
              toolPart.status = state.status;
            }
            if (state.input) {
              toolPart.input = state.input;
            }
            if (state.output) {
              toolPart.output = state.output;
            }
            if (state.error) {
              toolPart.error = state.error;
            }
            return toolPart;
          }
          if (part.type === "tool-call") {
            return {
              type: "tool-call",
              tool: part.name,
              callID: part.id,
              input: part.input
            };
          }
          if (part.type === "tool-result") {
            return {
              type: "tool-result",
              tool: part.name,
              callID: part.id,
              output: part.result
            };
          }
          return null;
        }).filter(Boolean);
      }
      return minimized;
    });
  }
  async saveContext(sessionId, messages) {
    if (!this.contextEnabled)
      return;
    try {
      const contextDir = join3(this.logDir, "context", sessionId);
      if (!existsSync3(contextDir)) {
        await mkdir2(contextDir, { recursive: true });
      }
      const minimized = this.minimizeForDebug(messages);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const contextFile = join3(contextDir, `${timestamp}.json`);
      await writeFile(contextFile, JSON.stringify(minimized, null, 2));
    } catch (error) {
      console.error("context-compress: failed to write context snapshot", error);
    }
  }
}

// lib/messages/legacy-residue.ts
var MANAGE_PROMPT_SIGNATURE = /compress (?:manage|squash)/i;
var CONTEXT_MANAGEMENT_MARKER = /CONTEXT (?:MANAGEMENT|SQUASH) REQUESTED/;
var STATUS_NOTIFICATION_HEADER = /\u25A3 Context Compress \|/;
var STATUS_NOTIFICATION_PROGRESS = /\u25A3 Compressing/;
var COMPRESSION_ONLY_REQUEST = /^(?:(?:please|pls|kindly|can you|could you|would you|now|thanks|thank you|context|conversation|history|manage|management|compress|compression|compact|cleanup|clean|up|prune|summari[sz]e|old|older|completed|past|previous|messages|turns|work|range|ranges|blocks?|cache|the|my|this|that|our|session|for|to|and|all|some|a|an|it|do|run|just|again)[\s,.;:!?-]*)+$/i;
var EMBEDDED_USER_MESSAGE = /<user-message>\s*([\s\S]*?)\s*<\/user-message>/;
function getMessageText(message) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join(`
`);
}
function hasToolPart(message, predicate) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some((part) => part.type === "tool" && typeof part.tool === "string" && predicate(part.tool));
}
var isCompressToolName = (tool) => tool === "compress_map" || tool === "compress" || tool === "squash";
function isManagePromptMessage(message) {
  if (message.info.role !== "user" || isIgnoredUserMessage(message)) {
    return false;
  }
  const text = getMessageText(message);
  return MANAGE_PROMPT_SIGNATURE.test(text) && CONTEXT_MANAGEMENT_MARKER.test(text);
}
function extractEmbeddedUserText(message) {
  const match = EMBEDDED_USER_MESSAGE.exec(getMessageText(message));
  const text = match?.[1]?.trim();
  return text ? text : undefined;
}
function isStatusNotificationMessage(message) {
  if (message.info.role !== "user" || !isIgnoredUserMessage(message)) {
    return false;
  }
  const text = getMessageText(message);
  return STATUS_NOTIFICATION_HEADER.test(text) || STATUS_NOTIFICATION_PROGRESS.test(text);
}
function isCompressionOnlyUserRequest(message) {
  if (message.info.role !== "user" || isIgnoredUserMessage(message)) {
    return false;
  }
  const text = getMessageText(message).trim();
  if (!text) {
    return false;
  }
  return COMPRESSION_ONLY_REQUEST.test(text);
}
function isStrongArtifact(message) {
  return isManagePromptMessage(message);
}
function isWeakArtifact(message) {
  if (message.info.role === "assistant") {
    return !hasToolPart(message, (tool) => !isCompressToolName(tool));
  }
  if (message.info.role === "user") {
    if (isIgnoredUserMessage(message)) {
      return true;
    }
    return isCompressionOnlyUserRequest(message);
  }
  return false;
}
function buildLegacyResidueSuppressionPlan(rawMessages) {
  const suppressed = new Set;
  const retainedTextByMessageId = new Map;
  let i = 0;
  while (i < rawMessages.length) {
    if (isStatusNotificationMessage(rawMessages[i])) {
      suppressed.add(rawMessages[i].info.id);
      i++;
      continue;
    }
    if (!isStrongArtifact(rawMessages[i])) {
      i++;
      continue;
    }
    let start = i;
    while (start > 0 && !suppressed.has(rawMessages[start - 1].info.id) && isCompressionOnlyUserRequest(rawMessages[start - 1])) {
      start--;
    }
    let end = i;
    while (end + 1 < rawMessages.length) {
      const candidate = rawMessages[end + 1];
      if (isStrongArtifact(candidate) || isWeakArtifact(candidate)) {
        end++;
        continue;
      }
      break;
    }
    if (end + 1 >= rawMessages.length) {
      break;
    }
    for (let k = start;k <= end; k++) {
      const candidate = rawMessages[k];
      const embeddedText = isManagePromptMessage(candidate) ? extractEmbeddedUserText(candidate) : undefined;
      if (embeddedText) {
        retainedTextByMessageId.set(candidate.info.id, embeddedText);
        continue;
      }
      suppressed.add(candidate.info.id);
    }
    i = end + 1;
  }
  return { suppressedMessageIds: suppressed, retainedTextByMessageId };
}

// lib/messages/blocks.ts
function orderCompressBlocks(rawMessages, summaries) {
  const positionsByMessageId = new Map;
  for (let index = 0;index < rawMessages.length; index++) {
    const messageId = rawMessages[index].info.id;
    const positions = positionsByMessageId.get(messageId) ?? [];
    positions.push(index);
    positionsByMessageId.set(messageId, positions);
  }
  const seenAnchors = new Set;
  const ordered = summaries.map((summary) => {
    const positions = positionsByMessageId.get(summary.anchorMessageId);
    if (seenAnchors.has(summary.anchorMessageId) || positions?.length !== 1) {
      throw new Error("could not reconcile an existing compressed block unambiguously with the current transcript. Nothing changed.");
    }
    seenAnchors.add(summary.anchorMessageId);
    return {
      summary,
      anchorIndex: positions[0]
    };
  });
  ordered.sort((left, right) => left.anchorIndex - right.anchorIndex);
  return ordered.map((block, index) => ({
    ...block,
    label: `b${index}`
  }));
}
function formatCompressBlockContent(block) {
  return `${COMPRESS_SUMMARY_PREFIX}[${block.label}]

${block.summary.summary}`;
}

// lib/messages/compress-transform.ts
var COMPRESSED_TOOL_OUTPUT_REPLACEMENT = "[Output pruned to save context.]";
var COMPRESSED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]";
var COMPRESSED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]";
var applyCompressTransforms = (state, messages) => {
  filterCompressedRanges(state, messages);
  stripCompressedTools(state, messages);
  stripToolOutputs(state, messages);
  stripToolInputs(state, messages);
  stripToolErrors(state, messages);
};
function isVisibleUserMessage(message) {
  return message.info.role === "user" && message.info.sourceType !== "synthetic" && !isIgnoredUserMessage(message);
}
function findActiveManagementTurn(state, rawMessages) {
  if (!state.managementTurns?.length) {
    return;
  }
  const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]));
  let best;
  for (const turn of state.managementTurns) {
    if (turn.completedAt) {
      continue;
    }
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex === undefined) {
      continue;
    }
    let bounded = false;
    for (let i = triggerIndex + 1;i < rawMessages.length; i++) {
      if (isVisibleUserMessage(rawMessages[i])) {
        bounded = true;
        break;
      }
    }
    if (bounded) {
      continue;
    }
    if (!best || triggerIndex > best.triggerIndex) {
      best = { turn, triggerIndex };
    }
  }
  return best;
}
function collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, endExclusive, retainedText, suppressedMessageIds, retainedTextByMessageId) {
  for (let i = triggerIndex;i < endExclusive; i++) {
    const message = rawMessages[i];
    if (i === triggerIndex && retainedText) {
      retainedTextByMessageId.set(message.info.id, retainedText);
      continue;
    }
    suppressedMessageIds.add(message.info.id);
  }
}
function buildManagementTurnSuppressionPlan(state, rawMessages) {
  const suppressedMessageIds = new Set;
  const retainedTextByMessageId = new Map;
  if (!state.managementTurns?.length) {
    return { suppressedMessageIds, retainedTextByMessageId };
  }
  const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]));
  for (const turn of state.managementTurns) {
    if (turn.cleanupVersion === 2)
      continue;
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex === undefined) {
      continue;
    }
    const retainedText = typeof turn.retainedText === "string" && turn.retainedText.trim().length > 0 ? turn.retainedText : undefined;
    let nextUserIndex = -1;
    for (let i = triggerIndex + 1;i < rawMessages.length; i++) {
      if (isVisibleUserMessage(rawMessages[i])) {
        nextUserIndex = i;
        break;
      }
    }
    if (nextUserIndex !== -1) {
      collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, nextUserIndex, retainedText, suppressedMessageIds, retainedTextByMessageId);
      continue;
    }
    const completedIndex = turn.completedAt && turn.completedMessageId ? indexByMessageId.get(turn.completedMessageId) : undefined;
    if (completedIndex === undefined || completedIndex <= triggerIndex) {
      continue;
    }
    collectSuppressedOrRetainedSpan(rawMessages, triggerIndex, completedIndex, retainedText, suppressedMessageIds, retainedTextByMessageId);
    for (let i = completedIndex + 1;i < rawMessages.length; i++) {
      const candidate = rawMessages[i];
      if (isVisibleUserMessage(candidate)) {
        break;
      }
      if (candidate.info.role === "user" && isIgnoredUserMessage(candidate)) {
        suppressedMessageIds.add(candidate.info.id);
      }
    }
  }
  return { suppressedMessageIds, retainedTextByMessageId };
}
function completionTool(turn) {
  return turn.source === "squash" ? "squash" : "compress";
}
function withoutCompletionTool(message, turn) {
  return message.parts.filter((part) => !(part.type === "tool" && part.tool === completionTool(turn)));
}
function buildV2CleanupPlan(state, rawMessages) {
  const suppressedMessageIds = new Set;
  const retainedTextByMessageId = new Map;
  const retainedPartsByMessageId = new Map;
  const protectedMessageIds = new Set;
  const turns = state.managementTurns.filter((turn) => turn.cleanupVersion === 2);
  const indexByMessageId = new Map(rawMessages.map((message, index) => [message.info.id, index]));
  const active = [...turns].reverse().find((turn) => {
    if (turn.completedAt)
      return false;
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex === undefined)
      return false;
    return !rawMessages.slice(triggerIndex + 1).some(isVisibleUserMessage);
  });
  const newestCompleted = [...turns].reverse().find((turn) => {
    const index = turn.completedMessageId ? indexByMessageId.get(turn.completedMessageId) : undefined;
    return index !== undefined && rawMessages[index].parts.some((part) => part.type === "tool" && part.tool === completionTool(turn));
  });
  const visibleAnchors = turns.flatMap((turn) => [
    indexByMessageId.get(turn.triggerMessageId),
    turn.completedMessageId ? indexByMessageId.get(turn.completedMessageId) : undefined
  ].filter((index) => index !== undefined));
  const firstV2Index = visibleAnchors.length > 0 ? Math.min(...visibleAnchors) : undefined;
  if (firstV2Index !== undefined) {
    for (let i = firstV2Index;i < rawMessages.length; i++) {
      protectedMessageIds.add(rawMessages[i].info.id);
    }
  }
  for (const turn of turns) {
    const triggerIndex = indexByMessageId.get(turn.triggerMessageId);
    if (triggerIndex !== undefined && turn !== active) {
      if (turn.retainedText)
        retainedTextByMessageId.set(turn.triggerMessageId, turn.retainedText);
      else
        suppressedMessageIds.add(turn.triggerMessageId);
    }
    const completedIndex = turn.completedMessageId ? indexByMessageId.get(turn.completedMessageId) : undefined;
    if (completedIndex !== undefined && turn !== newestCompleted) {
      const message = rawMessages[completedIndex];
      const parts = withoutCompletionTool(message, turn);
      if (parts.length > 0)
        retainedPartsByMessageId.set(message.info.id, parts);
      else
        suppressedMessageIds.add(message.info.id);
    }
    if (triggerIndex === undefined)
      continue;
    for (let i = triggerIndex + 1;i < rawMessages.length; i++) {
      const message = rawMessages[i];
      if (isVisibleUserMessage(message))
        break;
      if (message.info.role === "user" && isIgnoredUserMessage(message)) {
        suppressedMessageIds.add(message.info.id);
        continue;
      }
      if (turn !== active && !(turn === newestCompleted && message.info.id === turn.completedMessageId)) {
        const parts = withoutCompletionTool(message, turn);
        if (parts.length === message.parts.length)
          continue;
        if (parts.length > 0)
          retainedPartsByMessageId.set(message.info.id, parts);
        else
          suppressedMessageIds.add(message.info.id);
      }
    }
  }
  for (const messageId of suppressedMessageIds)
    protectedMessageIds.delete(messageId);
  return {
    suppressedMessageIds,
    retainedTextByMessageId,
    retainedPartsByMessageId,
    protectedMessageIds
  };
}
function createRetainedUserMessage(message, retainedText) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const textPart = parts.find((part) => part.type === "text");
  const retainedPart = textPart ? { ...textPart, text: retainedText } : {
    id: `prt_retained_${message.info.id}`,
    sessionID: message.info.sessionID,
    messageID: message.info.id,
    type: "text",
    text: retainedText
  };
  return {
    ...message,
    parts: [retainedPart]
  };
}
var transformMessagesForSearch = (rawMessages, state) => {
  const legacyPlan = buildLegacyResidueSuppressionPlan(rawMessages);
  const v2Plan = buildV2CleanupPlan(state, rawMessages);
  const hasLegacyFindings = legacyPlan.suppressedMessageIds.size > 0 || legacyPlan.retainedTextByMessageId.size > 0;
  if (!state.compressed.messageIds?.size && !state.compressSummaries.length && !state.managementTurns?.length && !hasLegacyFindings && v2Plan.suppressedMessageIds.size === 0 && v2Plan.retainedPartsByMessageId.size === 0) {
    return {
      transformed: [...rawMessages],
      syntheticMap: new Map
    };
  }
  const transformed = [];
  const syntheticMap = new Map;
  const orderedBlocks = orderCompressBlocks(rawMessages, state.compressSummaries);
  const blocksByAnchorId = new Map(orderedBlocks.map((block) => [block.summary.anchorMessageId, block]));
  const managementSuppression = buildManagementTurnSuppressionPlan(state, rawMessages);
  for (const [messageId, retainedText] of v2Plan.retainedTextByMessageId) {
    managementSuppression.retainedTextByMessageId.set(messageId, retainedText);
  }
  for (const messageId of v2Plan.suppressedMessageIds) {
    managementSuppression.suppressedMessageIds.add(messageId);
  }
  for (const [messageId, retainedText] of legacyPlan.retainedTextByMessageId) {
    if (!managementSuppression.retainedTextByMessageId.has(messageId)) {
      managementSuppression.retainedTextByMessageId.set(messageId, retainedText);
    }
  }
  for (const messageId of legacyPlan.suppressedMessageIds) {
    if (!managementSuppression.retainedTextByMessageId.has(messageId) && !v2Plan.retainedPartsByMessageId.has(messageId) && !v2Plan.protectedMessageIds.has(messageId)) {
      managementSuppression.suppressedMessageIds.add(messageId);
    }
  }
  for (const messageId of managementSuppression.retainedTextByMessageId.keys()) {
    managementSuppression.suppressedMessageIds.delete(messageId);
  }
  for (const messageId of v2Plan.retainedPartsByMessageId.keys()) {
    managementSuppression.suppressedMessageIds.delete(messageId);
  }
  for (const messageId of v2Plan.protectedMessageIds) {
    managementSuppression.suppressedMessageIds.delete(messageId);
  }
  for (let i = 0;i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    const msgId = msg.info.id;
    const block = blocksByAnchorId.get(msgId);
    if (block) {
      const summary = block.summary;
      const syntheticMessage = createSyntheticUserMessage(msg, formatCompressBlockContent(block), msg.info.variant, summary.anchorMessageId);
      transformed.push(syntheticMessage);
      syntheticMap.set(syntheticMessage.info.id, summary);
    }
    const retainedParts = v2Plan.retainedPartsByMessageId.get(msgId);
    if (retainedParts && !state.compressed.messageIds.has(msgId)) {
      transformed.push({ ...msg, parts: retainedParts });
      continue;
    }
    if (managementSuppression.suppressedMessageIds.has(msgId)) {
      continue;
    }
    const retainedText = managementSuppression.retainedTextByMessageId.get(msgId);
    if (retainedText && !state.compressed.messageIds.has(msgId)) {
      transformed.push(createRetainedUserMessage(msg, retainedText));
      continue;
    }
    if (state.compressed.messageIds.has(msgId)) {
      continue;
    }
    transformed.push(msg);
  }
  return {
    transformed,
    syntheticMap
  };
};
var stripCompressedTools = (state, messages) => {
  const messagesToRemove = [];
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const partsToRemove = [];
    for (const part of parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (!state.compressed.toolIds.has(part.callID)) {
        continue;
      }
      if (part.tool !== "edit" && part.tool !== "write") {
        continue;
      }
      partsToRemove.push(part.callID);
    }
    if (partsToRemove.length === 0) {
      continue;
    }
    msg.parts = parts.filter((part) => part.type !== "tool" || !partsToRemove.includes(part.callID));
    if (msg.parts.length === 0) {
      messagesToRemove.push(msg.info.id);
    }
  }
  if (messagesToRemove.length > 0) {
    const result = messages.filter((msg) => !messagesToRemove.includes(msg.info.id));
    messages.length = 0;
    messages.push(...result);
  }
};
var stripToolOutputs = (state, messages) => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (!state.compressed.toolIds.has(part.callID)) {
        continue;
      }
      if (part.state.status !== "completed") {
        continue;
      }
      if (part.tool === "question" || part.tool === "edit" || part.tool === "write") {
        continue;
      }
      part.state.output = COMPRESSED_TOOL_OUTPUT_REPLACEMENT;
    }
  }
};
var stripToolInputs = (state, messages) => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (!state.compressed.toolIds.has(part.callID)) {
        continue;
      }
      if (part.state.status !== "completed") {
        continue;
      }
      if (part.tool !== "question") {
        continue;
      }
      if (typeof part.state.input === "object" && part.state.input.questions !== undefined) {
        part.state.input.questions = COMPRESSED_QUESTION_INPUT_REPLACEMENT;
      }
    }
  }
};
var stripToolErrors = (state, messages) => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const part of parts) {
      if (part.type !== "tool") {
        continue;
      }
      if (!state.compressed.toolIds.has(part.callID)) {
        continue;
      }
      if (part.state.status !== "error") {
        continue;
      }
      const input = part.state.input;
      if (input && typeof input === "object") {
        for (const key of Object.keys(input)) {
          if (typeof input[key] === "string") {
            input[key] = COMPRESSED_TOOL_ERROR_INPUT_REPLACEMENT;
          }
        }
      }
    }
  }
};
var filterCompressedRanges = (state, messages) => {
  const { transformed } = transformMessagesForSearch(messages, state);
  messages.length = 0;
  messages.push(...transformed);
};

// lib/messages/context-map.ts
function deriveProtectedTailMessageIds(messages, protectedTurns) {
  if (protectedTurns <= 0 || messages.length === 0)
    return [];
  let protectedStart = 0;
  let stepCount = 0;
  for (let index = messages.length - 1;index >= 0; index--) {
    protectedStart = index;
    const parts = Array.isArray(messages[index].parts) ? messages[index].parts : [];
    stepCount += parts.filter((part) => part.type === "step-start").length;
    if (stepCount >= protectedTurns)
      break;
  }
  if (stepCount === 0) {
    protectedStart = Math.max(0, messages.length - protectedTurns);
  }
  return messages.slice(protectedStart).map((message) => message.info.id);
}

// lib/messages/prune.ts
var PROTECTED_STEPS = 10;
var MEDIA_CHARS = 6000;
var REWRITE_TOLERANCE = 1.5;
var CACHE_TTL_MS = 60 * 60000;
var PROTECTED_TOOLS = new Set([
  "patch",
  "edit",
  "write",
  "subagent",
  "task",
  "skill",
  "todowrite",
  "todoread",
  "question",
  "compress",
  "squash",
  "get_goal",
  "create_goal",
  "update_goal"
]);
async function pruneStaleToolOutputs(messages, state, logger, anchored) {
  if (findActiveManagementTurn(state, messages))
    return;
  const read = state.modelContext?.cacheReadRatio ?? 0.1;
  const tail = currentTail(messages, state);
  const recent = new Set(deriveProtectedTailMessageIds(tail, PROTECTED_STEPS));
  const candidates = tail.flatMap((message, index) => recent.has(message.info.id) ? [] : message.parts.flatMap((part) => isPrunable(part, state) ? [{ index, part }] : []));
  if (candidates.length === 0)
    return;
  const prunedChars = candidates.reduce((total, { part }) => total + prunableChars(part), 0);
  const suffixChars = anchored ? tail.slice(candidates[0].index).reduce((total, message) => total + messageChars(message, state), 0) : state.compressSummaries.reduce((total, block) => total + block.summary.length, 0) + messages.filter((message) => !isMessageCompacted(state, message)).reduce((total, message) => total + messageChars(message, state), 0);
  const stepsAfter = [];
  tail.reduceRight((after, message, index) => {
    stepsAfter[index] = after;
    return after + message.parts.filter((part) => part.type === "step-start").length;
  }, 0);
  const rent = candidates.reduce((total, { index, part }) => total + prunableChars(part) * read * (stepsAfter[index] - PROTECTED_STEPS), 0);
  const rewrite = (suffixChars - prunedChars) * (1 - read);
  const last = messages.findLast((message) => message.info.role === "assistant" && message.info.time.completed !== undefined);
  const cold = last !== undefined && Date.now() - last.info.time.created > CACHE_TTL_MS;
  if (!cold && rent * REWRITE_TOLERANCE < rewrite)
    return;
  const candidateState = {
    ...state,
    compressed: {
      ...state.compressed,
      toolIds: new Set([
        ...state.compressed.toolIds,
        ...candidates.map(({ part }) => part.callID)
      ])
    }
  };
  if (!await saveSessionState(candidateState, logger)) {
    logger.warn("Pruning skipped because its marks could not be saved", {
      sessionId: state.sessionId
    });
    return;
  }
  commitDurableSessionState(state, candidateState);
  logger.info("Pruned stale tool outputs", {
    sessionId: state.sessionId,
    tools: candidates.length,
    prunedChars,
    suffixChars,
    rent,
    anchored,
    cold
  });
}
function pruneFrontier(messages, state) {
  return currentTail(messages, state).flatMap((message) => message.parts).find((part) => isPrunable(part, state))?.callID;
}
function currentTail(messages, state) {
  return messages.slice(messages.findLastIndex((m) => isMessageCompacted(state, m)) + 1);
}
function isPrunable(part, state) {
  return part.type === "tool" && !PROTECTED_TOOLS.has(part.tool) && !state.compressed.toolIds.has(part.callID) && (part.state.status === "completed" || part.state.status === "error");
}
function prunableChars(part) {
  if (part.state.status === "completed")
    return outputChars(part.state.output);
  return Object.values(part.state.input).reduce((total, value) => total + (typeof value === "string" ? value.length : 0), 0);
}
function messageChars(message, state) {
  return message.parts.reduce((total, part) => {
    if (part.type === "text" || part.type === "reasoning")
      return total + part.text.length;
    if (part.type !== "tool")
      return total;
    const output = part.state.status === "completed" && !state.compressed.toolIds.has(part.callID) ? outputChars(part.state.output) : 0;
    return total + JSON.stringify(part.state.input).length + output;
  }, 0);
}
function outputChars(output) {
  if (typeof output === "string")
    return output.length;
  if (!Array.isArray(output))
    return 0;
  return output.reduce((total, item) => {
    if (item?.type === "text" && typeof item.text === "string")
      return total + item.text.length;
    return total + (item?.type === "file" ? MEDIA_CHARS : 0);
  }, 0);
}

// lib/messages/v2-transform.ts
function transformV2Messages(raw, state, modelMessages) {
  const projected = new Map(raw.map((message) => [message.info.id, message]));
  const tools = new Map;
  for (const message of raw) {
    for (const part of message.parts) {
      if (part.type !== "tool")
        continue;
      if (tools.has(part.callID))
        throw new Error(`Duplicate projected tool call ID: ${part.callID}`);
      tools.set(part.callID, message.info.id);
    }
  }
  const owned = new Map;
  const before = new Map;
  const pending = [];
  const system = raw.filter((message) => message.info.sourceType === "system");
  const usedSystem = new Set;
  for (const message of modelMessages) {
    const owner = message.id === undefined && message.role === "assistant" && message.content.every((part) => part.type === "text" || part.type === "reasoning") ? undefined : resolveOwner(message, projected, tools, system, usedSystem);
    if (!owner) {
      pending.push(message);
      continue;
    }
    if (pending.length > 0)
      before.set(owner, [...before.get(owner) ?? [], ...pending.splice(0)]);
    const current = owned.get(owner) ?? [];
    current.push(message);
    owned.set(owner, current);
  }
  const project = (message) => {
    if (message.info.role === "user" && isIgnoredUserMessage(message))
      return [];
    if (!projected.has(message.info.id))
      return [summaryMessage(message)];
    const source = projected.get(message.info.id);
    if (!source)
      throw new Error(`Missing projected source for ${message.info.id}`);
    const messages = owned.get(message.info.id) ?? [];
    if (messages.length === 0)
      return [];
    if (message.info.role === "assistant")
      return transformToolPair(messages, message, state);
    if (message.info.role === "user" && text(message) !== text(source)) {
      return messages.map((item) => ({
        ...item,
        content: [{ type: "text", text: text(message) }]
      }));
    }
    return messages;
  };
  const transformed = structuredClone(raw);
  applyCompressTransforms(state, transformed);
  return [
    ...transformed.flatMap((message) => [
      ...before.get(message.info.id) ?? [],
      ...project(message)
    ]),
    ...pending
  ];
}
function resolveOwner(message, projected, tools, system, usedSystem) {
  if (message.id && projected.has(message.id))
    return message.id;
  const resultOwners = new Set(message.content.flatMap((part) => part.type === "tool-result" && typeof part.id === "string" ? [tools.get(part.id)] : []).filter((owner) => owner !== undefined));
  if (resultOwners.size === 1 && message.content.every((part) => part.type === "tool-result")) {
    return [...resultOwners][0];
  }
  if (message.role === "system") {
    const content = textFromModel(message);
    const match = system.find((candidate) => !usedSystem.has(candidate.info.id) && text(candidate) === content);
    if (match) {
      usedSystem.add(match.info.id);
      return match.info.id;
    }
  }
  if (message.id === undefined && (message.role === "user" || message.role === "system"))
    return;
  throw new Error(`Could not map a model-facing ${message.role} message to authoritative projected history`);
}
function transformToolPair(messages, target, state) {
  const tools = new Map(target.parts.filter((part) => part.type === "tool").map((part) => [part.callID, part]));
  return messages.flatMap((message) => {
    const content = message.content.flatMap((part) => {
      if (part.type !== "tool-call" && part.type !== "tool-result" || typeof part.id !== "string")
        return [part];
      const tool = tools.get(part.id);
      if (!tool)
        return [];
      if (part.type === "tool-call" && typeof tool.state.input !== "string") {
        return [{ ...part, input: structuredClone(tool.state.input) }];
      }
      if (part.type === "tool-result" && state.compressed.toolIds.has(tool.callID) && tool.state.status === "completed" && tool.tool !== "question" && tool.tool !== "edit" && tool.tool !== "write") {
        return [
          { ...part, result: { type: "text", value: String(tool.state.output ?? "") } }
        ];
      }
      return [part];
    });
    if (content.length === 0)
      return [];
    return [{ ...message, content }];
  });
}
function summaryMessage(message) {
  return {
    id: message.info.id,
    role: "user",
    content: [{ type: "text", text: text(message) }]
  };
}
function text(message) {
  return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join(`
`);
}
function textFromModel(message) {
  return message.content.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(`
`);
}

// lib/state/fork.ts
async function inheritForkCompression(session, client, state, logger, childMessages) {
  if (!state.sessionId || state.hasPersistedState)
    return;
  const child = await session.get({ sessionID: state.sessionId });
  if (!child.fork)
    return;
  const parentMessages = await listSessionMessages(client, child.fork.sessionID);
  const parentState = await loadSessionState(child.fork.sessionID, logger, parentMessages);
  if (parentState.status === "error")
    throw new Error("Cannot read parent compression state for fork");
  if (parentState.status === "missing")
    return;
  const resolved = await resolveForkBoundary(client, child.fork, parentMessages);
  if (!resolved)
    return;
  const { boundary, before } = resolved;
  const parentPrefix = parentMessages.slice(0, before ? boundary : boundary + 1).filter((message) => {
    if (message.info.sourceType === "assistant")
      return message.info.time.completed !== undefined;
    if (message.info.sourceType === "shell")
      return message.info.finish === "stop";
    if (message.info.sourceType === "compaction") {
      return message.info.time.completed !== undefined || message.info.error !== undefined;
    }
    return true;
  });
  if (childMessages.length < parentPrefix.length) {
    throw new Error("Fork transcript is shorter than its copied parent history");
  }
  const mapped = new Map;
  for (let index = 0;index < parentPrefix.length; index++) {
    const parent = parentPrefix[index];
    const forked = childMessages[index];
    if (parent.info.sourceType !== forked.info.sourceType || parent.info.time.created !== forked.info.time.created || JSON.stringify(parent.parts) !== JSON.stringify(forked.parts))
      throw new Error("Fork transcript differs from the copied parent history");
    mapped.set(parent.info.id, forked.info.id);
  }
  const messageID = (id) => {
    const result = mapped.get(id);
    if (!result)
      throw new Error(`Compression state references a message outside the fork: ${id}`);
    return result;
  };
  const summaries = parentState.state.compressSummaries.filter((summary) => {
    const anchor = parentMessages.findIndex((message) => message.info.id === summary.anchorMessageId);
    if (anchor < 0)
      throw new Error("Parent compression block has no transcript anchor");
    if (anchor > boundary || anchor === boundary && before)
      return false;
    if (!mapped.has(summary.anchorMessageId))
      throw new Error("Fork did not copy a compression block anchor");
    return summary.messageIds.every((id) => mapped.has(id));
  });
  const turns = parentState.state.managementTurns.filter((turn) => {
    if (!mapped.has(turn.triggerMessageId))
      return false;
    return [
      turn.triggeredByMessageId,
      turn.completedMessageId,
      ...turn.protectedMessageIds ?? []
    ].every((id) => !id || mapped.has(id));
  });
  const compressedMessages = new Set(summaries.flatMap((summary) => summary.messageIds.map(messageID)));
  const parentBlockMessages = new Set(parentState.state.compressSummaries.flatMap((summary) => summary.messageIds.flatMap((id) => mapped.get(id) ?? [])));
  const childTools = new Set(childMessages.slice(0, parentPrefix.length).filter((message) => compressedMessages.has(message.info.id) || !parentBlockMessages.has(message.info.id)).flatMap((message) => message.parts.flatMap((part) => part.type === "tool" ? [part.callID] : [])));
  const candidate = {
    ...state,
    compressed: {
      messageIds: new Set(parentState.state.compressed.messageIds.filter((id) => mapped.has(id) && compressedMessages.has(messageID(id))).map(messageID)),
      toolIds: new Set(parentState.state.compressed.toolIds.filter((id) => childTools.has(id)))
    },
    anthropicStubIds: parentState.state.anthropicStubIds && new Set(parentState.state.anthropicStubIds.filter((id) => childTools.has(id))),
    compressSummaries: summaries.map((summary) => ({
      ...summary,
      anchorMessageId: messageID(summary.anchorMessageId),
      messageIds: summary.messageIds.map(messageID)
    })),
    managementTurns: turns.map((turn) => ({
      ...turn,
      triggerMessageId: messageID(turn.triggerMessageId),
      ...turn.triggeredByMessageId ? { triggeredByMessageId: messageID(turn.triggeredByMessageId) } : {},
      ...turn.completedMessageId ? { completedMessageId: messageID(turn.completedMessageId) } : {},
      ...turn.protectedMessageIds ? { protectedMessageIds: turn.protectedMessageIds.map(messageID) } : {}
    })),
    pruneOff: parentState.state.pruneOff,
    lastCompaction: parentState.state.lastCompaction ?? 0
  };
  if (!await saveSessionState(candidate, logger))
    throw new Error("Cannot persist fork compression state");
}
async function resolveForkBoundary(client, fork, parentMessages) {
  const boundary = parentMessages.findIndex((message) => message.info.id === fork.boundary.messageID);
  if (boundary >= 0)
    return { boundary, before: fork.boundary.type === "before" };
  const projected = await client.session.context({ sessionID: fork.sessionID });
  const position = projected.findIndex((value) => value.id === fork.boundary.messageID);
  if (position < 0)
    return;
  const earlier = new Set(projected.slice(0, position).map((value) => value.id));
  return {
    boundary: parentMessages.findLastIndex((message) => earlier.has(message.info.id)),
    before: false
  };
}

// lib/tools/compress.ts
async function compress(client, logger, pending, sessionID, input) {
  const summary = input.trim();
  if (!summary)
    throw new Error("compress requires a non-empty summary. Nothing was folded.");
  const admitted = await client.session.compact({ sessionID }).catch((error) => {
    const cause = error instanceof Error ? error.message : String(error);
    logger.error("Fold could not start", { sessionId: sessionID, error: cause });
    throw new Error(`Nothing was folded: the compaction could not start. ${cause}`);
  });
  pending.set(sessionID, { summary, inboxID: admitted.id });
  logger.info("Fold summary saved", { sessionId: sessionID, chars: summary.length });
  return "Summary saved. The fold applies right after this step.";
}

// lib/plugin.ts
var FOLD_NOTE = "This summary was written at a context fold by the agent doing the work. The fold changed only the " + "conversation, not files or running jobs, and the user's instructions still apply. If work was in " + "progress, continue it from the next step above; if it was finished or waiting for the user, leave it " + "that way.";
var CACHE_ANCHORS_HEADER = "x-opencode-cache-anchors";
var TOOL_CLEARING_HEADER = "x-opencode-tool-clearing";
var isAnthropic = (providerID) => providerID === "anthropic" || providerID.startsWith("anthropic-");
async function setup(context) {
  const client = pluginClient(context.session);
  const configContext = { directory: context.location.directory };
  const config = getConfig(configContext);
  if (!config.enabled)
    return () => {
      return;
    };
  const logger = new Logger({ daily: config.dailyLog ?? config.debug, context: config.debug });
  const stateManager = new SessionStateManager;
  const registrations = [];
  if (config.commands.enabled) {
    registrations.push(await context.command.transform((draft) => {
      draft.add({
        name: "compress",
        description: "Manage deterministic context compression",
        execute: async (input) => {
          refreshConfig(config, configContext);
          await handleCompressCommand({
            command: "compress",
            sessionID: input.sessionID,
            arguments: input.prompt.text
          }, { client, stateManager, logger, config });
        }
      });
    }));
  }
  const pending = new Map;
  if (config.tools.compress.permission !== "deny") {
    registrations.push(await context.tool.transform((draft) => {
      draft.add({
        name: "compress",
        description: COMPRESS,
        input: z.object({
          summary: z.string().describe("The summary described by this tool's instructions")
        }),
        options: { codemode: false, permission: "compress" },
        execute: async (input, toolContext) => ({
          content: await compress(client, logger, pending, toolContext.sessionID, input.summary)
        })
      });
    }));
  }
  const anchors = new Map;
  const prunedFrontiers = new Map;
  const sentFrontiers = new Map;
  const clearings = new Map;
  const applyCompression = async (event, kind) => {
    const anthropic = isAnthropic(event.model.providerID);
    const anchored = kind !== "generate" && anthropic;
    if (kind !== "generate") {
      refreshConfig(config, configContext);
      anchors.delete(event.sessionID);
    }
    setSessionSelection(client, event.sessionID, {
      agent: event.agent,
      model: {
        providerID: event.model.providerID,
        id: event.model.id,
        variant: event.model.variant
      }
    });
    const messages = await listSessionMessages(client, event.sessionID);
    if (messages.length === 0)
      return;
    const state = stateManager.get(event.sessionID);
    const modelContext = await resolveModelContext(context, event.model);
    let transformed;
    await stateManager.runExclusive(event.sessionID, async () => {
      if (modelContext)
        state.modelContext = modelContext;
      let syncResult = await checkSession(state, logger, messages);
      if (!state.persistenceSynchronized) {
        logger.error("Skipping compression for this turn: session state is not synchronized, so the model sees the untransformed transcript", {
          sessionID: event.sessionID,
          source: syncResult.source
        });
        return;
      }
      if (!state.hasPersistedState) {
        await inheritForkCompression(context.session, client, state, logger, messages);
        syncResult = await checkSession(state, logger, messages);
        if (!state.persistenceSynchronized)
          throw new Error("Cannot load inherited fork compression state");
      }
      if (anthropic)
        state.anthropicStubIds ??= new Set(state.compressed.toolIds);
      const stubs = anthropic ? state.anthropicStubIds : undefined;
      const before = anchored ? pruneFrontier(messages, state) : undefined;
      if (kind === "context" && !state.pruneOff)
        await pruneStaleToolOutputs(messages, state, logger, anchored);
      const after = anchored ? pruneFrontier(messages, state) : undefined;
      transformed = transformV2Messages(messages, stubs ? { ...state, compressed: { ...state.compressed, toolIds: stubs } } : state, event.messages);
      event.messages.splice(0, event.messages.length, ...transformed);
      const previous = sentFrontiers.get(event.sessionID) ?? before;
      if (anchored && previous !== undefined && previous !== after)
        prunedFrontiers.set(event.sessionID, previous);
      if (anchored && after !== undefined)
        sentFrontiers.set(event.sessionID, after);
      const ids = [...new Set([prunedFrontiers.get(event.sessionID), after])].filter((id) => id !== undefined);
      if (anchored && ids.length > 0)
        anchors.set(event.sessionID, ids);
      if (anchored)
        clearings.set(event.sessionID, JSON.stringify({ from: after, exclude: [...PROTECTED_TOOLS] }));
    });
    if (kind === "context" && transformed)
      await logger.saveContext(event.sessionID, transformed);
  };
  registrations.push(await context.session.hook("context", (event) => applyCompression(event, "context")), await context.session.hook("generate", (event) => applyCompression(event, "generate")), await context.session.hook("compaction", (event) => {
    const summary = pending.get(event.sessionID)?.summary;
    if (summary === undefined)
      return applyCompression(event, "compaction");
    event.result = {
      summary: `${summary}

${FOLD_NOTE}`,
      metadata: { keepID: undefined }
    };
    logger.info("Fold applied", { sessionId: event.sessionID });
  }), await context.session.hook("model.request", (event) => {
    if (event.kind !== "primary" && event.kind !== "compaction")
      return;
    if (!isAnthropic(event.model.providerID))
      return;
    const ids = anchors.get(event.sessionID);
    anchors.delete(event.sessionID);
    if (ids)
      event.headers[CACHE_ANCHORS_HEADER] = ids.join(",");
    const clearing = clearings.get(event.sessionID);
    if (clearing)
      event.headers[TOOL_CLEARING_HEADER] = clearing;
  }));
  const foldRequest = createFoldRequestHandler(client, stateManager, logger, config, pending, (sessionID, event) => ownsSession(context, sessionID, event));
  const events = context.event.subscribe()[Symbol.asyncIterator]();
  const eventLoop = runEvents(events, foldRequest, pending, client, stateManager, logger, context);
  return async () => {
    await events.return?.();
    await Promise.all(registrations.map((registration) => registration.dispose()));
    await eventLoop;
  };
}
async function resolveModelContext(context, model) {
  const result = await context.model.list();
  const match = result.data.find((value) => value.providerID === model.providerID && value.id === model.id && typeof value.limit.context === "number");
  if (!match)
    return;
  const price = match.cost[0];
  return {
    providerId: model.providerID,
    modelId: model.id,
    contextLimit: match.limit.context,
    cacheReadRatio: price && price.input > 0 ? price.cache.read / price.input : undefined
  };
}
async function runEvents(events, foldRequest, pending, client, stateManager, logger, context) {
  for (;; ) {
    const item = await events.next().catch((error) => {
      logger.error("Context Compress event stream failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    if (!item || item.done)
      return;
    try {
      await foldRequest(item.value);
      const event = isRecord(item.value) ? item.value : {};
      const data = isRecord(event.data) ? event.data : {};
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
      if (sessionID === undefined)
        continue;
      if (event.type === "session.forked") {
        if (!await ownsSession(context, sessionID, event))
          continue;
        const messages = await listSessionMessages(client, sessionID);
        await stateManager.runExclusive(sessionID, async () => {
          const state = stateManager.get(sessionID);
          await checkSession(state, logger, messages);
          if (!state.persistenceSynchronized || state.hasPersistedState)
            return;
          await inheritForkCompression(context.session, client, state, logger, messages);
        });
        continue;
      }
      if (event.type === "session.compaction.failed" || event.type === "session.inbox.cancelled" && data.inboxID === pending.get(sessionID)?.inboxID)
        pending.delete(sessionID);
      if (event.type !== "session.compaction.ended")
        continue;
      pending.delete(sessionID);
      if (!await ownsSession(context, sessionID, event))
        continue;
      const messages = await listSessionMessages(client, sessionID);
      await stateManager.runExclusive(sessionID, () => reconcileSessionLifecycle(stateManager.get(sessionID), sessionID, logger, messages));
    } catch (error) {
      logger.error("Context Compress event handling failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
async function ownsSession(context, sessionID, event) {
  const ref = isRecord(event) && isRecord(event.location) ? event.location : undefined;
  if (ref && typeof ref.directory === "string") {
    return ref.directory === context.location.directory && ref.workspaceID === context.location.workspaceID;
  }
  const location = (await context.session.get({ sessionID })).location;
  return location.directory === context.location.directory;
}

// index.ts
var stage_default = Plugin.define({
  id: "opencode-context-compress",
  setup
});
export {
  stage_default as default
};

//# debugId=05D750A7B9A578DD64756E2164756E21
//# sourceMappingURL=index.js.map
