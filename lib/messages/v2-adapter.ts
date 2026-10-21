import { isRecord } from "../shared-utils.js"
import type { WithParts } from "../state/types.js"

type RecordValue = Record<string, unknown>

export interface V2SessionSelection {
    readonly agent?: string
    readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
}

export function adaptProjectedMessages(
    sessionID: string,
    values: readonly unknown[],
    selection?: V2SessionSelection,
): WithParts[] {
    const seen = new Set<string>()
    let parentID: string | undefined
    return values
        .filter((value) => !isRecord(value) || value.type !== "idle")
        .map((value) => {
            const message = requireRecord(value, "session message")
            const id = requireString(message.id, "session message id")
            if (seen.has(id)) throw new Error(`Duplicate projected session message ID: ${id}`)
            seen.add(id)
            const type = requireString(message.type, `session message ${id} type`)
            const time = requireRecord(message.time, `session message ${id} time`)
            const created = requireNumber(time.created, `session message ${id} created time`)

            if (type === "user") {
                parentID = id
                return user(sessionID, id, created, message, selection)
            }
            if (type === "synthetic") return synthetic(sessionID, id, created, message, selection)
            if (type === "assistant")
                return assistant(sessionID, id, created, message, time, parentID)
            if (type === "compaction") return compaction(sessionID, id, created, message)
            if (type === "system" || type === "skill") {
                return system(
                    sessionID,
                    id,
                    created,
                    type,
                    typeof message.text === "string" ? message.text : "",
                )
            }
            if (type === "shell") {
                const output =
                    isRecord(message.output) && typeof message.output.output === "string"
                        ? message.output.output
                        : ""
                const entry = system(
                    sessionID,
                    id,
                    created,
                    type,
                    `The following shell command was executed by the user:\n\nCommand:\n${String(message.command ?? "")}\n\nOutput:\n${output}`,
                )
                entry.info.finish = message.status === "running" ? undefined : "stop"
                return entry
            }
            if (type === "location-switched") {
                const location = isRecord(message.location) ? message.location.directory : undefined
                return system(
                    sessionID,
                    id,
                    created,
                    type,
                    typeof location === "string"
                        ? `The working directory has been changed to ${location}.`
                        : "",
                )
            }
            if (type === "agent-switched" || type === "model-switched")
                return system(sessionID, id, created, type, "")
            throw new Error(`Unsupported projected session message type: ${type}`)
        })
}

function user(
    sessionID: string,
    id: string,
    created: number,
    message: RecordValue,
    selection: V2SessionSelection | undefined,
): WithParts {
    return {
        info: {
            id,
            sessionID,
            role: "user",
            sourceType: "user",
            agent: selection?.agent,
            model: selection?.model
                ? { providerID: selection.model.providerID, modelID: selection.model.id }
                : undefined,
            variant: selection?.model?.variant,
            time: { created },
        },
        parts:
            typeof message.text === "string" && message.text.length > 0
                ? [{ type: "text", text: message.text }]
                : [],
    }
}

function synthetic(
    sessionID: string,
    id: string,
    created: number,
    message: RecordValue,
    selection: V2SessionSelection | undefined,
): WithParts {
    const metadata = isRecord(message.metadata) ? message.metadata : {}
    return {
        info: {
            id,
            sessionID,
            role: "user",
            sourceType: "synthetic",
            agent: selection?.agent,
            model: selection?.model
                ? { providerID: selection.model.providerID, modelID: selection.model.id }
                : undefined,
            variant: selection?.model?.variant,
            time: { created },
        },
        parts: [
            {
                type: "text",
                text: typeof message.text === "string" ? message.text : "",
                synthetic: true,
                ...(metadata["opencode.context-compress.ignored"] === true
                    ? { ignored: true }
                    : {}),
            },
        ],
    }
}

function assistant(
    sessionID: string,
    id: string,
    created: number,
    message: RecordValue,
    time: RecordValue,
    parentID: string | undefined,
): WithParts {
    const model = requireRecord(message.model, `assistant message ${id} model`)
    const providerID = requireString(model.providerID, `assistant message ${id} provider`)
    const modelID = requireString(model.id, `assistant message ${id} model id`)
    const completed = typeof time.completed === "number" ? time.completed : undefined
    const content = Array.isArray(message.content) ? message.content : []
    return {
        info: {
            id,
            sessionID,
            role: "assistant",
            sourceType: "assistant",
            ...(parentID ? { parentID } : {}),
            time: { created, ...(completed === undefined ? {} : { completed }) },
            agent: typeof message.agent === "string" ? message.agent : undefined,
            providerID,
            modelID,
            model: { providerID, modelID },
            finish: typeof message.finish === "string" ? message.finish : undefined,
            error: message.error,
            tokens: adaptTokens(message.tokens),
        },
        parts: [{ type: "step-start" }, ...content.map((part) => adaptAssistantPart(id, part))],
    }
}

function adaptAssistantPart(messageID: string, value: unknown): WithParts["parts"][number] {
    const part = requireRecord(value, `assistant message ${messageID} content`)
    const type = requireString(part.type, `assistant message ${messageID} content type`)
    if (type === "text" || type === "reasoning") {
        return {
            type,
            text: typeof part.text === "string" ? part.text : "",
        }
    }
    if (type !== "tool") throw new Error(`Unsupported assistant content type: ${type}`)
    const state = requireRecord(part.state, `assistant tool ${String(part.id)} state`)
    const status = requireToolStatus(state.status)
    const input =
        status === "streaming"
            ? String(state.input ?? "")
            : isRecord(state.input)
              ? state.input
              : {}
    return {
        type: "tool",
        callID: requireString(part.id, "assistant tool id"),
        tool: requireString(part.name, "assistant tool name"),
        executed: part.executed === true,
        state: {
            status,
            input,
            ...(status === "completed" ? { output: toolOutput(state.content) } : {}),
            ...(status === "error" ? { error: state.error } : {}),
        },
    }
}

function compaction(
    sessionID: string,
    id: string,
    created: number,
    message: RecordValue,
): WithParts {
    const status = requireString(message.status, `compaction message ${id} status`)
    return {
        info: {
            id,
            sessionID,
            role: "assistant",
            sourceType: "compaction",
            summary: true,
            finish: status === "completed" ? "stop" : undefined,
            error: status === "failed" ? message.error : undefined,
            time: { created, ...(status === "completed" ? { completed: created } : {}) },
        },
        parts: [
            {
                type: "compaction",
                summary: typeof message.summary === "string" ? message.summary : undefined,
            },
        ],
    }
}

function system(
    sessionID: string,
    id: string,
    created: number,
    sourceType: string,
    text: string,
): WithParts {
    return {
        info: { id, sessionID, role: "system", sourceType, time: { created } },
        parts: text ? [{ type: "text", text }] : [],
    }
}

function adaptTokens(value: unknown) {
    if (!isRecord(value)) return undefined
    const cache = isRecord(value.cache) ? value.cache : {}
    return {
        input: numberOrZero(value.input),
        output: numberOrZero(value.output),
        reasoning: numberOrZero(value.reasoning),
        cache: { read: numberOrZero(cache.read), write: numberOrZero(cache.write) },
    }
}

function toolOutput(value: unknown) {
    if (!Array.isArray(value)) return value
    if (
        value.length === 1 &&
        isRecord(value[0]) &&
        value[0].type === "text" &&
        typeof value[0].text === "string"
    ) {
        return value[0].text
    }
    return value
}

function requireToolStatus(value: unknown): "streaming" | "running" | "completed" | "error" {
    if (value === "streaming" || value === "running" || value === "completed" || value === "error")
        return value
    throw new Error(`Unsupported assistant tool state: ${String(value)}`)
}

function requireRecord(value: unknown, label: string) {
    if (!isRecord(value)) throw new Error(`Invalid ${label}`)
    return value
}

function requireString(value: unknown, label: string) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`)
    return value
}

function requireNumber(value: unknown, label: string) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${label}`)
    return value
}

function numberOrZero(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}
