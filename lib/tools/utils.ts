import type { WithParts } from "../state"

export function getCompletedToolOutputText(
    part: { tool?: unknown; callID?: unknown },
    output: unknown,
    options?: { stringifyNonString?: boolean; requireTruthy?: boolean },
): string | undefined {
    if (part.tool === "image_generation") {
        const callId =
            typeof part.callID === "string" && part.callID.length > 0
                ? part.callID.length > 56
                    ? `${part.callID.slice(0, 53)}...`
                    : part.callID
                : undefined
        return typeof part.callID === "string" && part.callID.length > 0
            ? `[generated image: ${callId}]`
            : "[generated image]"
    }

    if (options?.requireTruthy ? !output : output === undefined || output === null) {
        return undefined
    }

    if (typeof output === "string") {
        return output
    }

    if (options?.stringifyNonString) {
        return JSON.stringify(output)
    }

    return undefined
}

export function extractMessageContent(msg: WithParts): string {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    let content = ""

    for (const part of parts) {
        const p = part as Record<string, unknown>

        switch (part.type) {
            case "text":
            case "reasoning":
                if (typeof p.text === "string") {
                    content += " " + p.text
                }
                break

            case "tool": {
                const state = p.state as Record<string, unknown> | undefined
                if (!state) break

                // Include tool output (completed or error)
                if (state.status === "completed") {
                    const output = getCompletedToolOutputText(part, state.output)
                    if (typeof output === "string") {
                        content += " " + output
                    }
                } else if (state.status === "error" && typeof state.error === "string") {
                    content += " " + state.error
                }

                // Include tool input
                if (state.input) {
                    content +=
                        " " +
                        (typeof state.input === "string"
                            ? state.input
                            : JSON.stringify(state.input))
                }
                break
            }

            case "compaction":
                if (typeof p.summary === "string") {
                    content += " " + p.summary
                }
                break

            case "subtask":
                if (typeof p.summary === "string") {
                    content += " " + p.summary
                }
                if (typeof p.result === "string") {
                    content += " " + p.result
                }
                break
        }
    }

    return content
}

export function collectToolIdsInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const toolIds: string[] = []

    for (let i = startIndex; i <= endIndex; i++) {
        const msg = messages[i]
        const parts = Array.isArray(msg.parts) ? msg.parts : []

        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                if (!toolIds.includes(part.callID)) {
                    toolIds.push(part.callID)
                }
            }
        }
    }

    return toolIds
}

export function collectContentInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const contents: string[] = []
    for (let i = startIndex; i <= endIndex; i++) {
        const msg = messages[i]
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text") {
                contents.push(part.text)
            } else if (part.type === "tool") {
                const toolState = part.state as any
                if (toolState?.input) {
                    contents.push(
                        typeof toolState.input === "string"
                            ? toolState.input
                            : JSON.stringify(toolState.input),
                    )
                }
                if (toolState?.status === "completed") {
                    const output = getCompletedToolOutputText(part, toolState.output, {
                        requireTruthy: true,
                        stringifyNonString: true,
                    })
                    if (typeof output === "string") {
                        contents.push(output)
                    }
                } else if (toolState?.status === "error" && toolState?.error) {
                    contents.push(
                        typeof toolState.error === "string"
                            ? toolState.error
                            : JSON.stringify(toolState.error),
                    )
                }
            }
        }
    }
    return contents
}
