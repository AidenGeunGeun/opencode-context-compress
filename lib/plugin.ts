import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { z } from "zod"
import { createAutomaticCompressionEventHandler } from "./auto-compression.js"
import { getConfig, refreshConfig } from "./config.js"
import { generateNativeCompactionNoticeId } from "./commands/manage.js"
import { handleCompressCommand } from "./commands/route.js"
import { Logger } from "./logger.js"
import { PROTECTED_TOOLS, pruneFrontier, pruneStaleToolOutputs } from "./messages/prune.js"
import type { ModelMessage } from "./messages/v2-transform.js"
import { transformV2Messages } from "./messages/v2-transform.js"
import { isRecord } from "./shared-utils.js"
import {
    listSessionMessages,
    pluginClient,
    promptSession,
    setSessionSelection,
} from "./sdk/client.js"
import { checkSession, reconcileSessionLifecycle, SessionStateManager } from "./state/index.js"
import { inheritForkCompression } from "./state/fork.js"
import { createCompressTool, createSquashTool } from "./tools/index.js"

type Registration = Awaited<ReturnType<Plugin.Context["session"]["hook"]>>

// The plugin API cannot veto native auto-compaction, so flag the misconfiguration when it runs.
// Manual /compact is a deliberate reset and gets no notice.
const NATIVE_AUTO_COMPACTION_NOTICE =
    "OpenCode native auto-compaction started in this session. Context Compress replaces it, and " +
    'this compaction will clear every compression block. Set `"compaction": { "auto": false }` ' +
    "in your OpenCode config."

// Tool call IDs a request should place a cache marker before; the anthropic-auth plugin applies them
// to the wire body before it signs the request, because hook order between plugins is not fixed.
const CACHE_ANCHORS_HEADER = "x-opencode-cache-anchors"
const TOOL_CLEARING_HEADER = "x-opencode-tool-clearing"
// Claude accounts served by the anthropic-auth plugin, which reads the two headers above: `anthropic` and any extra
// account it adds as `anthropic-<n>`.
const isAnthropic = (providerID: string) => providerID === "anthropic" || providerID.startsWith("anthropic-")

export async function setup(context: Plugin.Context): Promise<() => Promise<void> | void> {
    const client = pluginClient(context.session)
    const configContext = { directory: context.location.directory }
    const config = getConfig(configContext)
    if (!config.enabled) return () => undefined

    const logger = new Logger({ daily: config.dailyLog ?? config.debug, context: config.debug })
    const stateManager = new SessionStateManager()
    const registrations: Registration[] = []

    if (config.commands.enabled) {
        registrations.push(
            await context.command.transform((draft) => {
                draft.add({
                    name: "compress",
                    description: "Manage deterministic context compression",
                    execute: async (input) => {
                        refreshConfig(config, configContext)
                        await handleCompressCommand(
                            {
                                command: "compress",
                                sessionID: input.sessionID,
                                arguments: input.prompt.text,
                            },
                            { client, stateManager, logger, config },
                        )
                    },
                })
            }),
        )
    }

    if (config.tools.compress.permission !== "deny") {
        const compress = createCompressTool({ client, stateManager, logger, config })
        const squash = createSquashTool({ client, stateManager, logger, config })
        registrations.push(
            await context.tool.transform((draft) => {
                draft.add({
                    name: "compress",
                    description: compress.description,
                    input: z.object({
                        summary: z.string().describe(compress.args.summary.description),
                        topic: z.string().describe(compress.args.topic.description),
                    }),
                    options: { codemode: false, permission: "compress" },
                    execute: async (input, toolContext) => ({
                        content: await compress.execute(input, toolContext),
                    }),
                })
                draft.add({
                    name: "squash",
                    description: squash.description,
                    input: z.object({
                        from: z.string().describe(squash.args.from.description),
                        to: z.string().describe(squash.args.to.description),
                        summary: z.string().describe(squash.args.summary.description),
                        topic: z.string().describe(squash.args.topic.description),
                    }),
                    options: { codemode: false, permission: "compress" },
                    execute: async (input, toolContext) => ({
                        content: await squash.execute(input, toolContext),
                    }),
                })
            }),
        )
    }

    // Cache anchors computed by a session's latest context hook, read by its next primary model request.
    const anchors = new Map<string, string[]>()
    // The frontier before each session's latest prune. It stays anchored until the next prune, so a retry of
    // a prune request that never reached the provider still resumes the cache there.
    const prunedFrontiers = new Map<string, string>()
    // The frontier each session's latest Anthropic request anchored and cleared before. A prune on another
    // provider moves the frontier too, so the next Anthropic request resumes the cache here.
    const sentFrontiers = new Map<string, string>()
    // Server-side clearing for each session's Anthropic requests: the calls before `from` are cleared. It
    // stays set until the next context hook, so a retried request clears the same calls.
    const clearings = new Map<string, string>()
    const applyCompression = async (event: SessionContext, kind: "context" | "generate") => {
        // Only Anthropic requests carry the anchor. Other providers have no markers; measured OpenAI reads
        // after an edit fall back to an earlier point, often the end of the system prompt.
        const anthropic = isAnthropic(event.model.providerID)
        const anchored = kind === "context" && anthropic
        if (kind === "context") {
            // Settings apply without a restart: every request re-reads a changed config file first.
            refreshConfig(config, configContext)
            anchors.delete(event.sessionID)
        }
        setSessionSelection(client, event.sessionID, {
            agent: event.agent,
            model: {
                providerID: event.model.providerID,
                id: event.model.id,
                variant: event.model.variant,
            },
        })
        const messages = await listSessionMessages(client, event.sessionID)
        if (messages.length === 0) return
        const state = stateManager.get(event.sessionID)
        const modelContext = await resolveModelContext(context, event.model)
        let transformed: ModelMessage[] | undefined
        await stateManager.runExclusive(event.sessionID, async () => {
            if (modelContext) state.modelContext = modelContext
            let syncResult = await checkSession(state, logger, messages)
            if (!state.persistenceSynchronized) {
                logger.error(
                    "Skipping compression for this turn: session state is not synchronized, so the model sees the untransformed transcript",
                    {
                        sessionID: event.sessionID,
                        source: syncResult.source,
                    },
                )
                return
            }
            if (!state.hasPersistedState) {
                await inheritForkCompression(context.session, client, state, logger, messages)
                syncResult = await checkSession(state, logger, messages)
                if (!state.persistenceSynchronized)
                    throw new Error("Cannot load inherited fork compression state")
            }
            // Anthropic drops every thinking block after a changed message. Fix the stubs it has seen before
            // this request can prune; it sees later prunes only as server-side clearing (`clearings`).
            if (anthropic) state.anthropicStubIds ??= new Set(state.compressed.toolIds)
            const stubs = anthropic ? state.anthropicStubIds : undefined
            // A prune moves the frontier, so the request anchors both: it resumes the cache at the old
            // frontier and writes the new one for the next prune.
            const before = anchored ? pruneFrontier(messages, state) : undefined
            if (kind === "context" && !state.pruneOff)
                await pruneStaleToolOutputs(messages, state, logger, anchored)
            const after = anchored ? pruneFrontier(messages, state) : undefined
            transformed = transformV2Messages(
                messages,
                stubs ? { ...state, compressed: { ...state.compressed, toolIds: stubs } } : state,
                event.messages as unknown as ModelMessage[],
            )
            event.messages.splice(
                0,
                event.messages.length,
                ...(transformed as unknown as typeof event.messages),
            )
            const previous = sentFrontiers.get(event.sessionID) ?? before
            if (anchored && previous !== undefined && previous !== after)
                prunedFrontiers.set(event.sessionID, previous)
            if (anchored && after !== undefined) sentFrontiers.set(event.sessionID, after)
            const ids = [...new Set([prunedFrontiers.get(event.sessionID), after])].filter(
                (id) => id !== undefined,
            )
            if (anchored && ids.length > 0) anchors.set(event.sessionID, ids)
            if (anchored)
                clearings.set(
                    event.sessionID,
                    JSON.stringify({ from: after, exclude: [...PROTECTED_TOOLS] }),
                )
        })
        if (kind === "context" && transformed)
            await logger.saveContext(event.sessionID, transformed)
    }
    registrations.push(
        await context.session.hook("context", (event) => applyCompression(event, "context")),
        await context.session.hook("generate", (event) => applyCompression(event, "generate")),
        await context.session.hook("model.request", (event) => {
            if (event.kind !== "primary" || !isAnthropic(event.model.providerID)) return
            const ids = anchors.get(event.sessionID)
            anchors.delete(event.sessionID)
            if (ids) event.headers[CACHE_ANCHORS_HEADER] = ids.join(",")
            const clearing = clearings.get(event.sessionID)
            if (clearing) event.headers[TOOL_CLEARING_HEADER] = clearing
        }),
    )

    const automatic = createAutomaticCompressionEventHandler(
        client,
        stateManager,
        logger,
        config,
        (sessionID, event) => ownsSession(context, sessionID, event),
    )
    const events = context.event.subscribe()[Symbol.asyncIterator]()
    const eventLoop = runEvents(events, automatic, client, stateManager, logger, context)

    return async () => {
        await events.return?.()
        await Promise.all(registrations.map((registration) => registration.dispose()))
        await eventLoop
    }
}

async function resolveModelContext(
    context: Plugin.Context,
    model: { providerID: string; id: string },
) {
    const result = await context.model.list()
    const match = result.data.find(
        (value) =>
            value.providerID === model.providerID &&
            value.id === model.id &&
            typeof value.limit.context === "number",
    )
    if (!match) return
    const price = match.cost[0]
    return {
        providerId: model.providerID,
        modelId: model.id,
        contextLimit: match.limit.context,
        cacheReadRatio: price && price.input > 0 ? price.cache.read / price.input : undefined,
    }
}

async function runEvents(
    events: AsyncIterator<unknown>,
    automatic: (event: unknown) => Promise<void>,
    client: ReturnType<typeof pluginClient>,
    stateManager: SessionStateManager,
    logger: Logger,
    context: Plugin.Context,
) {
    for (;;) {
        const item = await events.next().catch((error) => {
            logger.error("Context Compress event stream failed", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
        if (!item || item.done) return
        try {
            await automatic(item.value)
            const event = isRecord(item.value) ? item.value : {}
            const data = isRecord(event.data) ? event.data : {}
            const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
            if (sessionID === undefined) continue
            if (event.type === "session.forked") {
                if (!(await ownsSession(context, sessionID, event))) continue
                const messages = await listSessionMessages(client, sessionID)
                await stateManager.runExclusive(sessionID, async () => {
                    const state = stateManager.get(sessionID)
                    await checkSession(state, logger, messages)
                    if (!state.persistenceSynchronized || state.hasPersistedState) return
                    await inheritForkCompression(context.session, client, state, logger, messages)
                })
                continue
            }
            if (event.type === "session.compaction.started" && data.reason === "auto") {
                if (!(await ownsSession(context, sessionID, event))) continue
                await promptSession(client, {
                    sessionId: sessionID,
                    parts: [{ type: "text", text: NATIVE_AUTO_COMPACTION_NOTICE }],
                    noReply: true,
                    messageId: generateNativeCompactionNoticeId(sessionID, event),
                })
                continue
            }
            if (event.type !== "session.compaction.ended") continue
            if (!(await ownsSession(context, sessionID, event))) continue
            const messages = await listSessionMessages(client, sessionID)
            await stateManager.runExclusive(sessionID, () =>
                reconcileSessionLifecycle(stateManager.get(sessionID), sessionID, logger, messages),
            )
        } catch (error) {
            logger.error("Context Compress event handling failed", {
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}

async function ownsSession(
    context: Plugin.Context,
    sessionID: string,
    event: unknown,
): Promise<boolean> {
    const ref = isRecord(event) && isRecord(event.location) ? event.location : undefined
    if (ref && typeof ref.directory === "string") {
        return (
            ref.directory === context.location.directory &&
            ref.workspaceID === context.location.workspaceID
        )
    }
    const location = (await context.session.get({ sessionID })).location
    return location.directory === context.location.directory
}
