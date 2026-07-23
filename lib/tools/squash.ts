import { tool } from "@opencode-ai/plugin/tool"
import type { CompressSummary, SessionState, WithParts } from "../state/index.js"
import type { CompressToolContext } from "./types.js"
import { commitDurableSessionState, reconcileSessionLifecycle } from "../state/index.js"
import { saveSessionState } from "../state/persistence.js"
import { loadPrompt } from "../prompts/index.js"
import { estimateTokensBatch } from "../token-utils.js"
import { findActiveManagementTurn } from "../messages/compress-transform.js"
import {
    formatCompressBlockContent,
    orderCompressBlocks,
    type OrderedCompressBlock,
} from "../messages/blocks.js"
import { listSessionMessages } from "../sdk/client.js"

const SQUASH_TOOL_DESCRIPTION = loadPrompt("squash-tool-spec")
const BLOCK_LABEL = /^b(?:0|[1-9]\d*)$/

interface SquashInput {
    from: string
    to: string
    summary: string
    topic: string
}

function parseBlockLabel(value: unknown, field: "from" | "to"): number {
    if (typeof value !== "string" || !BLOCK_LABEL.test(value)) {
        throw new Error(`squash requires ${field} to be a current block label such as b1`)
    }
    const index = Number(value.slice(1))
    if (!Number.isSafeInteger(index)) {
        throw new Error(`squash requires ${field} to be a current block label such as b1`)
    }
    return index
}

function findExecutingSquashMessage(
    rawMessages: WithParts[],
    messageId: string,
    callId?: string,
): { message: WithParts; index: number } | undefined {
    const matches = rawMessages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.info.id === messageId)
    if (matches.length !== 1 || matches[0].message.info.role !== "assistant") return undefined

    const hasExecutingCall = matches[0].message.parts.some(
        (part) =>
            part.type === "tool" &&
            part.tool === "squash" &&
            (!callId || part.callID === callId),
    )
    return hasExecutingCall ? matches[0] : undefined
}

function resolveAuthorizedSquash(
    rawMessages: WithParts[],
    state: SessionState,
    toolMessageId: string,
    callId?: string,
): { turn: SessionState["managementTurns"][number]; orderedBlocks: OrderedCompressBlock[] } {
    const executing = findExecutingSquashMessage(rawMessages, toolMessageId, callId)
    const active = findActiveManagementTurn(state, rawMessages)
    if (
        !executing ||
        !active ||
        active.turn.source !== "squash" ||
        executing.index <= active.triggerIndex
    ) {
        throw new Error(
            "squash is only authorized inside the active management turn created by the current user's `/compress squash` command. Nothing changed.",
        )
    }
    return {
        turn: active.turn,
        orderedBlocks: orderCompressBlocks(rawMessages, state.compressSummaries),
    }
}

function buildReplacement(
    selected: OrderedCompressBlock[],
    summary: string,
    topic: string,
): CompressSummary {
    const messageIds: string[] = []
    const seen = new Set<string>()
    for (const block of selected) {
        for (const messageId of block.summary.messageIds) {
            if (!seen.has(messageId)) {
                seen.add(messageId)
                messageIds.push(messageId)
            }
        }
    }
    return {
        anchorMessageId: selected[0].summary.anchorMessageId,
        messageIds,
        summary,
        topic,
    }
}

export function createSquashTool(ctx: CompressToolContext): ReturnType<typeof tool> {
    return tool({
        description: SQUASH_TOOL_DESCRIPTION,
        args: {
            from: tool.schema.string().describe("Inclusive current block label, for example b1"),
            to: tool.schema.string().describe("Inclusive current block label, for example b12"),
            summary: tool.schema.string().describe("Truthful replacement for only the selected blocks"),
            topic: tool.schema.string().describe("Short replacement block title"),
        },
        async execute(args, toolCtx) {
            const input = args as Partial<SquashInput>
            const fromIndex = parseBlockLabel(input.from, "from")
            const toIndex = parseBlockLabel(input.to, "to")
            const summary = typeof input.summary === "string" ? input.summary.trim() : ""
            const topic = typeof input.topic === "string" ? input.topic.trim() : ""
            if (!summary) throw new Error("squash requires a non-empty summary")
            if (!topic) throw new Error("squash requires a non-empty topic")

            const { client, stateManager, logger } = ctx
            const sessionId = toolCtx.sessionID
            const state = stateManager.get(sessionId)
            const outcome = await stateManager.runExclusive(sessionId, async () => {
                let rawMessages: WithParts[]
                try {
                    rawMessages = (await listSessionMessages(client, sessionId)) as WithParts[]
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    throw new Error(`squash could not fetch session messages: ${message}. Nothing changed.`)
                }
                if (rawMessages.length === 0) {
                    throw new Error("squash could not fetch any session messages. Nothing changed.")
                }

                await reconcileSessionLifecycle(client, state, sessionId, logger, rawMessages)
                if (!state.persistenceSynchronized) {
                    throw new Error("squash could not synchronize saved session state. Nothing changed.")
                }

                const callId = typeof (toolCtx as any).callID === "string" ? (toolCtx as any).callID : undefined
                const authorized = resolveAuthorizedSquash(
                    rawMessages,
                    state,
                    toolCtx.messageID,
                    callId,
                )
                if (fromIndex > toIndex) {
                    throw new Error("squash requires from to precede or equal to to. Nothing changed.")
                }
                if (
                    fromIndex >= authorized.orderedBlocks.length ||
                    toIndex >= authorized.orderedBlocks.length
                ) {
                    throw new Error("squash block range does not exist in the current block ordering. Nothing changed.")
                }
                if (toIndex - fromIndex + 1 < 2) {
                    throw new Error("squash requires a range containing at least two blocks. Nothing changed.")
                }

                const selected = authorized.orderedBlocks.slice(fromIndex, toIndex + 1)
                const replacement = buildReplacement(selected, summary, topic)
                const replacementLabel = selected[0].label
                const oldVisibleTokens = estimateTokensBatch(
                    selected.map(formatCompressBlockContent),
                    state.modelContext?.providerId,
                )
                const newVisibleTokens = estimateTokensBatch(
                    [formatCompressBlockContent({ label: replacementLabel, summary: replacement })],
                    state.modelContext?.providerId,
                )
                const estimatedSavedTokens = Math.max(0, oldVisibleTokens - newVisibleTokens)

                await toolCtx.ask({
                    permission: "compress",
                    patterns: ["*"],
                    always: ["*"],
                    metadata: {},
                })

                const orderedSummaries = authorized.orderedBlocks.map((block) => block.summary)
                const candidateSummaries = [
                    ...orderedSummaries.slice(0, fromIndex),
                    replacement,
                    ...orderedSummaries.slice(toIndex + 1),
                ]
                const completedAt = new Date().toISOString()
                const candidateManagementTurns = state.managementTurns.map((turn) =>
                    turn === authorized.turn
                        ? {
                              ...turn,
                              completedAt,
                              ...(callId ? { completedCallId: callId } : {}),
                              completedMessageId: toolCtx.messageID,
                          }
                        : turn,
                )
                const candidateState: SessionState = {
                    ...state,
                    compressSummaries: candidateSummaries,
                    managementTurns: candidateManagementTurns,
                    stats: {
                        compressTokenCounter: 0,
                        totalCompressTokens:
                            state.stats.totalCompressTokens + estimatedSavedTokens,
                    },
                    compressionMapSnapshot: undefined,
                }
                const persisted = await saveSessionState(candidateState, logger)
                if (!persisted) {
                    throw new Error("squash could not persist compression state. Nothing changed.")
                }
                commitDurableSessionState(state, candidateState)

                return {
                    oldFrom: selected[0].label,
                    oldTo: selected[selected.length - 1].label,
                    newLabel: replacementLabel,
                    topic,
                }
            })

            return `Squash complete. Replaced [${outcome.oldFrom}]-[${outcome.oldTo}] with [${outcome.newLabel}] "${outcome.topic}" durably; the replacement is already in effect. Uncompressed history was untouched. Do not call squash or compress again this turn.`
        },
    })
}
