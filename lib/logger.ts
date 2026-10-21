import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { inspect } from "node:util"
import { isRecord } from "./shared-utils.js"

/**
 * Errors have to reach `formatData` already flattened into one line: it drops any object
 * whose JSON exceeds 50 characters, `JSON.stringify` on an Error yields `{}`, and a log
 * entry is a single line. `inspect` keeps the stack, `cause`, and any error code, and
 * survives circular references, so nothing here can throw from inside a catch block.
 */
export function describeError(error: unknown): string {
    return inspect(error, { depth: 3, breakLength: Infinity }).replace(/\s*\n\s*/g, " ")
}

export class Logger {
    private logDir: string
    private dailyEnabled: boolean
    private contextEnabled: boolean

    constructor(options: { daily: boolean; context: boolean }) {
        this.dailyEnabled = options.daily
        this.contextEnabled = options.context
        const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
        this.logDir = join(configHome, "opencode", "logs", "compress")
    }

    private async ensureLogDir() {
        if (!existsSync(this.logDir)) {
            await mkdir(this.logDir, { recursive: true })
        }
    }

    private formatData(data?: Record<string, unknown>): string {
        if (!data) return ""

        const parts: string[] = []
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined || value === null) continue

            // Format arrays compactly
            if (Array.isArray(value)) {
                if (value.length === 0) continue
                parts.push(
                    `${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`,
                )
            } else if (typeof value === "object") {
                const str = JSON.stringify(value)
                if (str.length < 50) {
                    parts.push(`${key}=${str}`)
                }
            } else {
                parts.push(`${key}=${value}`)
            }
        }
        return parts.join(" ")
    }

    private getCallerFile(skipFrames: number = 3): string {
        const originalPrepareStackTrace = Error.prepareStackTrace
        try {
            const err = new Error()
            Error.prepareStackTrace = (_, stack) => stack
            const stack = err.stack as unknown as NodeJS.CallSite[]
            Error.prepareStackTrace = originalPrepareStackTrace

            // Skip specified number of frames to get to actual caller
            for (let i = skipFrames; i < stack.length; i++) {
                const filename = stack[i]?.getFileName()
                if (filename && !filename.includes("/logger.")) {
                    // Extract just the filename without path and extension
                    const match = filename.match(/([^/\\]+)\.[tj]s$/)
                    return match ? match[1] : filename
                }
            }
            return "unknown"
        } catch {
            return "unknown"
        }
    }

    private async write(
        level: string,
        component: string,
        message: string,
        data?: Record<string, unknown>,
    ) {
        if (!this.dailyEnabled) return

        try {
            await this.ensureLogDir()

            const timestamp = new Date().toISOString()
            const dataStr = this.formatData(data)

            const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? ` | ${dataStr}` : ""}\n`

            const dailyLogDir = join(this.logDir, "daily")
            if (!existsSync(dailyLogDir)) {
                await mkdir(dailyLogDir, { recursive: true })
            }

            const logFile = join(dailyLogDir, `${new Date().toISOString().split("T")[0]}.log`)
            await writeFile(logFile, logLine, { flag: "a" })
        } catch (error) {
            // The daily log is the failing channel here, so stderr is the only honest place left.
            console.error("context-compress: failed to write daily log", error)
        }
    }

    info(message: string, data?: Record<string, unknown>) {
        const component = this.getCallerFile(2)
        return this.write("INFO", component, message, data)
    }

    debug(message: string, data?: Record<string, unknown>) {
        const component = this.getCallerFile(2)
        return this.write("DEBUG", component, message, data)
    }

    warn(message: string, data?: Record<string, unknown>) {
        const component = this.getCallerFile(2)
        return this.write("WARN", component, message, data)
    }

    error(message: string, data?: Record<string, unknown>) {
        const component = this.getCallerFile(2)
        return this.write("ERROR", component, message, data)
    }

    /**
     * Strips unnecessary metadata from messages for cleaner debug logs.
     *
     * Removed:
     * - All IDs (id, sessionID, messageID, parentID, callID on parts)
     * - summary, path, cost, model, agent, mode, finish, providerID, modelID
     * - step-start and step-finish parts entirely
     * - snapshot fields
     * - ignored text parts
     *
     * Kept:
     * - role, time (created only), tokens (input, output, reasoning, cache)
     * - text, reasoning, tool parts with content
     * - tool calls with: tool, callID, input, output
     */
    private minimizeForDebug(messages: readonly unknown[]): Record<string, unknown>[] {
        return messages.map((message) => {
            const msg = isRecord(message) ? message : {}
            const info = isRecord(msg.info) ? msg.info : {}
            const time = isRecord(info.time) ? info.time : {}
            const minimized: Record<string, unknown> = {
                role: info.role ?? msg.role,
            }

            if (time.created) {
                minimized.time = time.created
            }

            if (isRecord(info.tokens)) {
                minimized.tokens = {
                    input: info.tokens.input,
                    output: info.tokens.output,
                    reasoning: info.tokens.reasoning,
                    cache: info.tokens.cache,
                }
            }

            const parts = msg.parts ?? msg.content
            if (Array.isArray(parts)) {
                minimized.parts = parts
                    .map((item: unknown) => {
                        const part = isRecord(item) ? item : {}

                        if (part.type === "step-start" || part.type === "step-finish") {
                            return null
                        }

                        if (part.type === "text") {
                            if (part.ignored) return null
                            return { type: "text", text: part.text }
                        }

                        if (part.type === "reasoning") {
                            return {
                                type: "reasoning",
                                text: part.text,
                            }
                        }

                        if (part.type === "tool") {
                            const state = isRecord(part.state) ? part.state : {}
                            const toolPart: Record<string, unknown> = {
                                type: "tool",
                                tool: part.tool,
                                callID: part.callID,
                            }

                            if (state.status) {
                                toolPart.status = state.status
                            }
                            if (state.input) {
                                toolPart.input = state.input
                            }
                            if (state.output) {
                                toolPart.output = state.output
                            }
                            if (state.error) {
                                toolPart.error = state.error
                            }

                            return toolPart
                        }

                        if (part.type === "tool-call") {
                            return {
                                type: "tool-call",
                                tool: part.name,
                                callID: part.id,
                                input: part.input,
                            }
                        }

                        if (part.type === "tool-result") {
                            return {
                                type: "tool-result",
                                tool: part.name,
                                callID: part.id,
                                output: part.result,
                            }
                        }

                        return null
                    })
                    .filter(Boolean)
            }

            return minimized
        })
    }

    async saveContext(sessionId: string, messages: readonly unknown[]) {
        if (!this.contextEnabled) return

        try {
            const contextDir = join(this.logDir, "context", sessionId)
            if (!existsSync(contextDir)) {
                await mkdir(contextDir, { recursive: true })
            }

            const minimized = this.minimizeForDebug(messages)
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
            const contextFile = join(contextDir, `${timestamp}.json`)
            await writeFile(contextFile, JSON.stringify(minimized, null, 2))
        } catch (error) {
            console.error("context-compress: failed to write context snapshot", error)
        }
    }
}
