import { z } from "zod";
import { getConfig, refreshConfig } from "./config.js";
import { handleCompressCommand } from "./commands/route.js";
import { createFoldRequestHandler } from "./fold-request.js";
import { Logger } from "./logger.js";
import { PROTECTED_TOOLS, pruneFrontier, pruneStaleToolOutputs } from "./messages/prune.js";
import { createPrefixWatch } from "./prefix-watch.js";
import { transformV2Messages } from "./messages/v2-transform.js";
import { isRecord } from "./shared-utils.js";
import { listSessionMessages, pluginClient, setSessionSelection } from "./sdk/client.js";
import { checkSession, reconcileSessionLifecycle, SessionStateManager } from "./state/index.js";
import { inheritForkCompression } from "./state/fork.js";
import { compress } from "./tools/compress.js";
import { COMPRESS } from "./prompts/index.js";
// After a fold the summary is the only message left, so it has to say how to resume.
const FOLD_NOTE = "This summary was written at a context fold by the agent doing the work. The fold changed only the " +
    "conversation, not files or running jobs, and the user's instructions still apply. If work was in " +
    "progress, continue it from the next step above; if it was finished or waiting for the user, leave it " +
    "that way.";
// Tool call IDs a request should place a cache marker before; the anthropic-auth plugin applies them
// to the wire body before it signs the request, because hook order between plugins is not fixed.
const CACHE_ANCHORS_HEADER = "x-opencode-cache-anchors";
const TOOL_CLEARING_HEADER = "x-opencode-tool-clearing";
// Claude accounts served by the anthropic-auth plugin, which reads the two headers above: `anthropic` and any extra
// account it adds as `anthropic-<n>`.
const isAnthropic = (providerID) => providerID === "anthropic" || providerID.startsWith("anthropic-");
export async function setup(context) {
    const client = pluginClient(context.session);
    const configContext = { directory: context.location.directory };
    const config = getConfig(configContext);
    if (!config.enabled)
        return () => undefined;
    const logger = new Logger({ daily: config.dailyLog ?? config.debug, context: config.debug });
    const stateManager = new SessionStateManager();
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
                        arguments: input.prompt.text,
                    }, { client, stateManager, logger, config });
                },
            });
        }));
    }
    // Summaries saved by `compress`, each kept until its compaction ends, fails, or is cancelled. The event
    // stream is ordered, so the entry also marks the step that called `compress` for the fold request to skip.
    const pending = new Map();
    if (config.tools.compress.permission !== "deny") {
        registrations.push(await context.tool.transform((draft) => {
            draft.add({
                name: "compress",
                description: COMPRESS,
                input: z.object({
                    summary: z
                        .string()
                        .describe("The summary described by this tool's instructions"),
                }),
                options: { codemode: false, permission: "compress" },
                execute: async (input, toolContext) => ({
                    content: await compress(client, logger, pending, toolContext.sessionID, input.summary),
                }),
            });
        }));
    }
    // Cache anchors computed by a session's latest context or compaction hook, read by its next model request.
    const anchors = new Map();
    // The frontier before each session's latest prune. It stays anchored until the next prune, so a retry of
    // a prune request that never reached the provider still resumes the cache there.
    const prunedFrontiers = new Map();
    // The frontier each session's latest Anthropic request anchored and cleared before. A prune on another
    // provider moves the frontier too, so the next Anthropic request resumes the cache here.
    const sentFrontiers = new Map();
    // Server-side clearing for each session's Anthropic requests: the calls before `from` are cleared. It
    // stays set until the next context hook, so a retried request clears the same calls.
    const clearings = new Map();
    // A compaction request summarizes the same conversation, so it gets the same message list to hit the
    // cache, but no prune: the conversation is about to be replaced.
    const applyCompression = async (event, kind) => {
        // Only Anthropic requests carry the anchor. Other providers have no markers; measured OpenAI reads
        // after an edit fall back to an earlier point, often the end of the system prompt.
        const anthropic = isAnthropic(event.model.providerID);
        const anchored = kind !== "generate" && anthropic;
        if (kind !== "generate") {
            // Settings apply without a restart: every request re-reads a changed config file first.
            refreshConfig(config, configContext);
            anchors.delete(event.sessionID);
        }
        setSessionSelection(client, event.sessionID, {
            agent: event.agent,
            model: {
                providerID: event.model.providerID,
                id: event.model.id,
                variant: event.model.variant,
            },
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
                    source: syncResult.source,
                });
                return;
            }
            if (!state.hasPersistedState) {
                await inheritForkCompression(context.session, client, state, logger, messages);
                syncResult = await checkSession(state, logger, messages);
                if (!state.persistenceSynchronized)
                    throw new Error("Cannot load inherited fork compression state");
            }
            // Anthropic drops every thinking block after a changed message. Fix the stubs it has seen before
            // this request can prune; it sees later prunes only as server-side clearing (`clearings`).
            if (anthropic)
                state.anthropicStubIds ??= new Set(state.compressed.toolIds);
            const stubs = anthropic ? state.anthropicStubIds : undefined;
            // A prune moves the frontier, so the request anchors both: it resumes the cache at the old
            // frontier and writes the new one for the next prune.
            const before = anchored ? pruneFrontier(messages, state) : undefined;
            if (kind === "context")
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
    const watchPrefix = createPrefixWatch(logger, (sessionID) => stateManager.get(sessionID).lastCompaction);
    registrations.push(await context.session.hook("context", (event) => applyCompression(event, "context")), await context.session.hook("generate", (event) => applyCompression(event, "generate")), 
    // A pending summary from `compress` replaces core's own summary request. Without one (a manual
    // `/compact`), core summarizes the conversation itself.
    await context.session.hook("compaction", (event) => {
        const summary = pending.get(event.sessionID)?.summary;
        if (summary === undefined)
            return applyCompression(event, "compaction");
        // Without `keepID`, core also keeps the newest messages verbatim, which repeat the summary.
        event.result = {
            summary: `${summary}\n\n${FOLD_NOTE}`,
            metadata: { keepID: undefined },
        };
        logger.info("Fold applied", { sessionId: event.sessionID });
    }), 
    // Diagnostics only: it reads a copy in the background, so it never delays the request and its failure never reaches it.
    await context.session.hook("http.request", (event) => {
        if (event.kind !== "primary" || !isAnthropic(event.model.providerID))
            return;
        if (event.request.method !== "POST" ||
            !new URL(event.request.url).pathname.endsWith("/messages"))
            return;
        void watchPrefix(event, event.request.clone()).catch((error) => logger.error("Prefix watch failed", {
            sessionId: event.sessionID,
            error: String(error),
        }));
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
    const match = result.data.find((value) => value.providerID === model.providerID &&
        value.id === model.id &&
        typeof value.limit.context === "number");
    if (!match)
        return;
    const price = match.cost[0];
    return {
        providerId: model.providerID,
        modelId: model.id,
        contextLimit: match.limit.context,
        cacheReadRatio: price && price.input > 0 ? price.cache.read / price.input : undefined,
    };
}
async function runEvents(events, foldRequest, pending, client, stateManager, logger, context) {
    for (;;) {
        const item = await events.next().catch((error) => {
            logger.error("Context Compress event stream failed", {
                error: error instanceof Error ? error.message : String(error),
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
                if (!(await ownsSession(context, sessionID, event)))
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
            // A summary must never outlive the compaction it was saved for.
            if (event.type === "session.compaction.failed" ||
                (event.type === "session.inbox.cancelled" &&
                    data.inboxID === pending.get(sessionID)?.inboxID))
                pending.delete(sessionID);
            if (event.type !== "session.compaction.ended")
                continue;
            pending.delete(sessionID);
            if (!(await ownsSession(context, sessionID, event)))
                continue;
            const messages = await listSessionMessages(client, sessionID);
            await stateManager.runExclusive(sessionID, () => reconcileSessionLifecycle(stateManager.get(sessionID), sessionID, logger, messages));
        }
        catch (error) {
            logger.error("Context Compress event handling failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
async function ownsSession(context, sessionID, event) {
    const ref = isRecord(event) && isRecord(event.location) ? event.location : undefined;
    if (ref && typeof ref.directory === "string") {
        return (ref.directory === context.location.directory &&
            ref.workspaceID === context.location.workspaceID);
    }
    const location = (await context.session.get({ sessionID })).location;
    return location.directory === context.location.directory;
}
//# sourceMappingURL=plugin.js.map