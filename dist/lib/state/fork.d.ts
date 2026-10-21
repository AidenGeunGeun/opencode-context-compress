import type { Plugin } from "@opencode/plugin";
import type { Logger } from "../logger.js";
import { type PluginClient } from "../sdk/client.js";
import type { SessionState, WithParts } from "./types.js";
/** Carry compression blocks into a V2 fork before its first model request. */
export declare function inheritForkCompression(session: Pick<Plugin.Context["session"], "get">, client: PluginClient, state: SessionState, logger: Logger, childMessages: WithParts[]): Promise<void>;
//# sourceMappingURL=fork.d.ts.map