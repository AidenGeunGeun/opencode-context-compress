import { buildContextMap } from "./context-map";
export const buildCompressContext = (state, messages, logger, providerId) => {
    return buildContextMap(messages, state, logger, providerId).mapText;
};
//# sourceMappingURL=inject.js.map