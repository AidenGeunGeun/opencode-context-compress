import { tool } from "@opencode-ai/plugin/tool";
import { loadPrompt } from "../prompts/index.js";
import { commitDurableSessionState, reconcileSessionLifecycle, } from "../state/index.js";
import { saveSessionState } from "../state/persistence.js";
import { getCurrentParams } from "../token-utils.js";
import { buildContextMap, createCompressionMapSnapshot, } from "../messages/context-map.js";
import { findActiveManagementTurn } from "../messages/compress-transform.js";
import { listSessionMessages } from "../sdk/client.js";
import { getPostCompressionCooldownRemaining } from "../auto-policy.js";
import { isIgnoredUserMessage } from "../messages/utils.js";
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
                    if (activeTurn?.turn.source === "automatic" &&
                        getPostCompressionCooldownRemaining(state, rawMessages) > 0) {
                        throw new Error("Automatic compression is still in its post-compression cooldown. No new map became authoritative; only the user can override the cooldown by running `/compress manage`.");
                    }
                    await toolCtx.ask({
                        permission: "compress_map",
                        patterns: ["*"],
                        always: ["*"],
                        metadata: {},
                    });
                    let boundaryMessageId;
                    let mapMessages;
                    let source;
                    let cooldownRemaining;
                    if (activeTurn) {
                        boundaryMessageId = activeTurn.turn.triggerMessageId;
                        mapMessages = rawMessages.slice(0, activeTurn.triggerIndex);
                        source = "management";
                    }
                    else {
                        let boundaryIndex = -1;
                        for (let index = rawMessages.length - 1; index >= 0; index--) {
                            const message = rawMessages[index];
                            if (message.info.role === "user" && !isIgnoredUserMessage(message)) {
                                boundaryIndex = index;
                                break;
                            }
                        }
                        if (boundaryIndex === -1) {
                            throw new Error("compress_map could not find a current visible user turn. No new map became authoritative.");
                        }
                        boundaryMessageId = rawMessages[boundaryIndex].info.id;
                        mapMessages = rawMessages.slice(0, boundaryIndex);
                        source = "normal";
                        cooldownRemaining = getPostCompressionCooldownRemaining(state, rawMessages);
                    }
                    const currentParams = getCurrentParams(state, mapMessages, logger);
                    const contextMap = buildContextMap(mapMessages, state, logger, currentParams.providerId, activeTurn?.turn.source === "automatic"
                        ? { protectedMessageIds: activeTurn.turn.protectedMessageIds ?? [] }
                        : undefined);
                    const candidateState = {
                        ...state,
                        compressionMapSnapshot: createCompressionMapSnapshot(boundaryMessageId, contextMap, { source, cooldownRemaining }),
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