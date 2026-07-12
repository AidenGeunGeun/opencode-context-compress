import { tool } from "@opencode-ai/plugin/tool";
import { loadPrompt } from "../prompts/index.js";
import { commitDurableSessionState, reconcileSessionLifecycle, } from "../state/index.js";
import { saveSessionState } from "../state/persistence.js";
import { getCurrentParams } from "../token-utils.js";
import { buildContextMap, createCompressionMapSnapshot, } from "../messages/context-map.js";
import { findActiveManagementTurn } from "../messages/compress-transform.js";
import { listSessionMessages } from "../sdk/client.js";
import { getPostCompressionCooldownRemaining } from "../auto-policy.js";
const COMPRESS_MAP_TOOL_DESCRIPTION = loadPrompt("compress-map-tool-spec");
export function createCompressMapTool(ctx) {
    return tool({
        description: COMPRESS_MAP_TOOL_DESCRIPTION,
        args: {},
        async execute(_args, toolCtx) {
            const { client, stateManager, logger } = ctx;
            const sessionId = toolCtx.sessionID;
            const state = stateManager.get(sessionId);
            try {
                return await stateManager.runExclusive(sessionId, async () => {
                    const rawMessages = (await listSessionMessages(client, sessionId));
                    await reconcileSessionLifecycle(client, state, sessionId, logger, rawMessages);
                    if (!state.persistenceSynchronized) {
                        throw new Error("compress_map could not load saved session state. No new map became authoritative; the last successfully returned current-turn map, if any, remains pinned.");
                    }
                    const activeTurn = findActiveManagementTurn(state, rawMessages);
                    if (!activeTurn) {
                        throw new Error("compress_map is available only inside a current compression-management turn. Nothing changed. Only the user can authorize manual compression by running `/compress manage`.");
                    }
                    if (activeTurn.turn.source === "automatic" &&
                        getPostCompressionCooldownRemaining(state, rawMessages) > 0) {
                        throw new Error("Automatic compression is still in its post-compression cooldown. No new map became authoritative; only the user can override the cooldown by running `/compress manage`.");
                    }
                    await toolCtx.ask({
                        permission: "compress_map",
                        patterns: ["*"],
                        always: ["*"],
                        metadata: {},
                    });
                    const preManagementMessages = rawMessages.slice(0, activeTurn.triggerIndex);
                    const currentParams = getCurrentParams(state, preManagementMessages, logger);
                    const contextMap = buildContextMap(preManagementMessages, state, logger, currentParams.providerId, activeTurn.turn.source === "automatic"
                        ? { protectedMessageIds: activeTurn.turn.protectedMessageIds ?? [] }
                        : undefined);
                    const candidateState = {
                        ...state,
                        compressionMapSnapshot: createCompressionMapSnapshot(activeTurn.turn.triggerMessageId, contextMap),
                    };
                    const persisted = await saveSessionState(candidateState, logger);
                    if (!persisted) {
                        throw new Error("compress_map could not save this snapshot. No new map became authoritative; the last successfully returned current-turn map, if any, remains pinned.");
                    }
                    commitDurableSessionState(state, candidateState);
                    return contextMap.mapText;
                });
            }
            catch (error) {
                if (error instanceof Error && /compress_map/.test(error.message))
                    throw error;
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`compress_map could not fetch and pin a map: ${message}. No new map became authoritative; the last successfully returned current-turn map, if any, remains pinned.`);
            }
        },
    });
}
//# sourceMappingURL=compress-map.js.map