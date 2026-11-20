export declare class Logger {
    private logDir;
    private cleanedDay?;
    private dailyEnabled;
    private contextEnabled;
    constructor(options: {
        daily: boolean;
        context: boolean;
    });
    private ensureLogDir;
    private formatData;
    private getCallerFile;
    private write;
    info(message: string, data?: Record<string, unknown>): Promise<void>;
    debug(message: string, data?: Record<string, unknown>): Promise<void>;
    warn(message: string, data?: Record<string, unknown>): Promise<void>;
    error(message: string, data?: Record<string, unknown>): Promise<void>;
    private minimizeForDebug;
    /** Appends one JSON record to `daily/<day>.<name>.log`, which the daily log's cleanup also deletes. */
    record(name: string, value: unknown): Promise<void>;
    saveContext(sessionId: string, messages: readonly unknown[]): Promise<void>;
}
//# sourceMappingURL=logger.d.ts.map