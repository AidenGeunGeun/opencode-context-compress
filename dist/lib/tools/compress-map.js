import { tool } from "@opencode-ai/plugin/tool";
import { loadPrompt } from "../prompts/index.js";
import { ensureSessionInitialized } from "../state/index.js";
import { saveSessionState } from "../state/persistence.js";
import { getCurrentParams } from "../token-utils.js";
import { buildContextMap } from "../messages/context-map.js";
import { listSessionMessages } from "../sdk/client.js";
const COMPRESS_MAP_TOOL_DESCRIPTION = loadPrompt("compress-map-tool-spec");
export function createCompressMapTool(ctx) {
    return tool({
        description: COMPRESS_MAP_TOOL_DESCRIPTION,
        args: {},
        async execute(_args, toolCtx) {
            const { client, stateManager, logger } = ctx;
            const sessionId = toolCtx.sessionID;
            const state = stateManager.get(sessionId);
            await toolCtx.ask({
                permission: "compress_map",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            });
            const rawMessages = (await listSessionMessages(client, sessionId));
            await ensureSessionInitialized(client, state, sessionId, logger, rawMessages);
            const currentParams = getCurrentParams(state, rawMessages, logger);
            const contextMap = buildContextMap(rawMessages, state, logger, currentParams.providerId);
            try {
                await saveSessionState(state, logger);
            }
            catch (err) {
                logger.error("Failed to persist state", { error: err.message });
            }
            return contextMap.mapText;
        },
    });
}
//# sourceMappingURL=compress-map.js.map