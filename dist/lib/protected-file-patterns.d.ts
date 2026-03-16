/**
 * Basic glob matching with support for `**`, `*`, and `?`.
 *
 * Notes:
 * - Matching is performed against the full (normalized) string.
 * - `*` and `?` do not match `/`.
 * - `**` matches across `/`.
 */
export declare function matchesGlob(inputPath: string, pattern: string): boolean;
export declare function getFilePathsFromParameters(tool: string, parameters: unknown): string[];
export declare function isProtected(filePaths: string[], patterns: string[]): boolean;
//# sourceMappingURL=protected-file-patterns.d.ts.map