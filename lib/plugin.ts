import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { z } from "zod"
import { createAutomaticCompressionEventHandler } from "./auto-compression.js"
import { getConfig } from "./config.js"
import { handleCompressCommand } from "./commands/route.js"
import { Logger } from "./logger.js"
import { isPostCompressionNoticeDue } from "./messages/post-compression-notice.js"
import type { ModelMessage } from "./messages/v2-transform.js"
import { transformV2Messages } from "./messages/v2-transform.js"
import { renderPostCompressionNotice } from "./prompts/index.js"
import { isRecord } from "./shared-utils.js"
import {
    listSessionMessages,
    pluginClient,
    promptSession,
    setSessionSelection,
} from "./sdk/client.js"
import {
    checkSession,
    reconcileSessionLifecycle,
    SessionStateManager,
    type WithParts,
} from "./state/index.js"
import { inheritForkCompression } from "./state/fork.js"
import { createCompressTool, createSquashTool } from "./tools/index.js"

type Registration = Awaited<ReturnType<Plugin.Context["session"]["hook"]>>

// The plugin API cannot veto native auto-compaction, so flag the misconfiguration when it runs.
// Manual /compact is a deliberate reset and gets no notice.
const NATIVE_AUTO_COMPACTION_NOTICE =
    "OpenCode native auto-compaction started in this session. Context Compress replaces it, and " +
    'this compaction clears every compression block. Set `"compaction": { "auto": false }` ' +
    "in opencode.jsonc."

export async function setup(context: Plugin.Context): Promise<() => Promise<void> | void> {
    const client = pluginClient(context.session)
    const config = getConfig({ directory: context.location.directory })
    if (!config.enabled) return () => undefined

    const logger = new Logger({ daily: config.dailyLog ?? config.debug, context: config.debug })
    const stateManager = new SessionStateManager()
    const registrations: Registration[] = []
    logger.info("Context Compress initialized")

    if (config.commands.enabled) {
        registrations.push(
            await context.command.transform((draft) => {
                draft.add({
                    name: "compress",
                    description: "Manage deterministic context compression",
                    execute: async (input) => {
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

    const applyCompression = async (event: SessionContext, kind: "context" | "generate") => {
        setSessionSelection(client, event.sessionID, {
            agent: event.agent,
            model: {
                providerID: event.model.providerID,
                id: event.model.id,
                variant: event.model.variant,
            },
        })
        const messages = (await listSessionMessages(client, event.sessionID)) as WithParts[]
        if (messages.length === 0) return
        const state = stateManager.get(event.sessionID)
        const modelContext = await resolveModelContext(context, event.model)
        let transformed: ModelMessage[] | undefined
        await stateManager.runExclusive(event.sessionID, async () => {
            state.currentAgent = event.agent
            state.variant = event.model.variant
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
            transformed = transformV2Messages(
                messages,
                state,
                logger,
                event.messages as unknown as ModelMessage[],
            )
            if (kind === "context" && isPostCompressionNoticeDue(state, messages)) {
                transformed.push({
                    role: "user",
                    content: [{ type: "text", text: renderPostCompressionNotice() }],
                })
            }
            event.messages.splice(
                0,
                event.messages.length,
                ...(transformed as unknown as typeof event.messages),
            )
        })
        if (kind === "context" && transformed)
            await logger.saveContext(event.sessionID, transformed)
    }
    registrations.push(
        await context.session.hook("context", (event) => applyCompression(event, "context")),
        await context.session.hook("generate", (event) => applyCompression(event, "generate")),
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
    return { providerId: model.providerID, modelId: model.id, contextLimit: match.limit.context }
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
            if (event.type === "session.forked" && typeof data.sessionID === "string") {
                if (!(await ownsSession(context, data.sessionID, event))) continue
                const messages = (await listSessionMessages(client, data.sessionID)) as WithParts[]
                await stateManager.runExclusive(data.sessionID, async () => {
                    const state = stateManager.get(data.sessionID as string)
                    await checkSession(state, logger, messages)
                    if (!state.persistenceSynchronized || state.hasPersistedState) return
                    await inheritForkCompression(context.session, client, state, logger, messages)
                })
                continue
            }
            if (
                event.type === "session.compaction.started" &&
                data.reason === "auto" &&
                typeof data.sessionID === "string"
            ) {
                if (!(await ownsSession(context, data.sessionID, event))) continue
                await promptSession(client, {
                    sessionId: data.sessionID,
                    parts: [{ type: "text", text: NATIVE_AUTO_COMPACTION_NOTICE }],
                    noReply: true,
                })
                continue
            }
            if (event.type !== "session.compaction.ended" || typeof data.sessionID !== "string")
                continue
            if (!(await ownsSession(context, data.sessionID, event))) continue
            const messages = (await listSessionMessages(client, data.sessionID)) as WithParts[]
            await stateManager.runExclusive(data.sessionID, () =>
                reconcileSessionLifecycle(
                    stateManager.get(data.sessionID as string),
                    data.sessionID as string,
                    logger,
                    messages,
                ),
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
