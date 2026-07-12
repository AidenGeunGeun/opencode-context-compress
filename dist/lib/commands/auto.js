import { getPostCompressionCooldownRemaining, resolveEffectiveAutoCompressionPolicy, } from "../auto-policy.js";
import { commitDurableSessionState, reconcileSessionLifecycle, } from "../state/state.js";
import { saveSessionState } from "../state/persistence.js";
import { getCurrentParams } from "../token-utils.js";
import { sendIgnoredMessage } from "../ui/notification.js";
import { listSessionMessages } from "../sdk/client.js";
const AUTO_USAGE = [
    "Usage: `/compress auto [status|on|off|threshold N|ratio N|reset]`",
    "`threshold N` requires a positive whole-token count; `ratio N` requires 1-99.",
].join("\n");
function formatRatioPercent(ratio) {
    return Number((ratio * 100).toFixed(6)).toString();
}
function parseAutoAction(args) {
    const action = args[0]?.toLowerCase() ?? "status";
    if (action === "status" && args.length <= 1)
        return { kind: "status" };
    if (action === "on" && args.length === 1)
        return { kind: "on" };
    if (action === "off" && args.length === 1)
        return { kind: "off" };
    if (action === "reset" && args.length === 1)
        return { kind: "reset" };
    if (action === "threshold" && args.length === 2 && /^[0-9]+$/.test(args[1])) {
        const value = Number(args[1]);
        if (Number.isSafeInteger(value) && value > 0) {
            return { kind: "threshold", value };
        }
    }
    if (action === "ratio" && args.length === 2 && /^[0-9]+$/.test(args[1])) {
        const value = Number(args[1]);
        if (Number.isInteger(value) && value >= 1 && value <= 99) {
            return { kind: "ratio", value };
        }
    }
    return { kind: "invalid" };
}
function formatStatus(config, state, messages) {
    const policy = resolveEffectiveAutoCompressionPolicy(config.autoCompression, state);
    const remaining = getPostCompressionCooldownRemaining(state, messages);
    const globalAvailability = policy.globallyEnabled
        ? "enabled"
        : "disabled by config; session commands cannot enable it";
    return [
        "**Automatic compression (this session)**",
        `- Global availability: ${globalAvailability}`,
        `- Effective state: ${policy.enabled ? "on" : "off"} (${policy.enabledSource})`,
        `- Token threshold: ${policy.tokenThreshold.toLocaleString("en-US")} tokens (${policy.tokenThresholdSource})`,
        `- Context ratio: ${formatRatioPercent(policy.contextWindowRatio)}% (${policy.contextWindowRatioSource})`,
        `- Cooldown: ${remaining} assistant ${remaining === 1 ? "response" : "responses"} remaining`,
    ].join("\n");
}
export async function handleAutoCommand(ctx) {
    const action = parseAutoAction(ctx.arguments);
    let response;
    if (action.kind === "invalid") {
        response = AUTO_USAGE;
    }
    else {
        response = await ctx.stateManager.runExclusive(ctx.sessionId, async () => {
            const messages = (await listSessionMessages(ctx.client, ctx.sessionId));
            await reconcileSessionLifecycle(ctx.client, ctx.state, ctx.sessionId, ctx.logger, messages);
            if (!ctx.state.persistenceSynchronized) {
                return "Automatic compression settings are unavailable because saved session state could not be loaded. No session setting was changed.";
            }
            if (action.kind === "status") {
                return formatStatus(ctx.config, ctx.state, messages);
            }
            const effectivePolicy = resolveEffectiveAutoCompressionPolicy(ctx.config.autoCompression, ctx.state);
            if (action.kind === "on" && effectivePolicy.enabled) {
                return `Automatic compression is already on (${effectivePolicy.enabledSource}). No session setting was changed.`;
            }
            if (action.kind === "off" && !effectivePolicy.enabled) {
                const source = effectivePolicy.globallyEnabled
                    ? effectivePolicy.enabledSource
                    : "global config";
                return `Automatic compression is already off (${source}). No session setting was changed.`;
            }
            if (!ctx.config.autoCompression.enabled) {
                return "Automatic compression is disabled globally. Session overrides cannot turn it on.";
            }
            const candidate = { ...ctx.state };
            let successMessage;
            switch (action.kind) {
                case "on":
                    candidate.autoCompressionEnabledOverride = true;
                    successMessage = "Automatic compression is on for this session.";
                    break;
                case "off":
                    candidate.autoCompressionEnabledOverride = false;
                    successMessage =
                        "Automatic compression is off for this session. Both absolute and ratio triggers are disabled.";
                    break;
                case "threshold":
                    candidate.autoCompressionTokenThresholdOverride = action.value;
                    successMessage = `Automatic compression threshold set to ${action.value.toLocaleString("en-US")} tokens for this session.`;
                    break;
                case "ratio":
                    candidate.autoCompressionContextWindowRatioOverride = action.value / 100;
                    successMessage = `Automatic compression ratio set to ${action.value}% for this session.`;
                    break;
                case "reset":
                    candidate.autoCompressionTokenThresholdOverride = undefined;
                    candidate.autoCompressionContextWindowRatioOverride = undefined;
                    successMessage = `Defaults reset to ${ctx.config.autoCompression.tokenThreshold.toLocaleString("en-US")} tokens and ${formatRatioPercent(ctx.config.autoCompression.contextWindowRatio)}% threshold.`;
                    break;
            }
            const persisted = await saveSessionState(candidate, ctx.logger);
            if (!persisted) {
                return "Automatic compression settings could not be saved. No session setting was changed.";
            }
            commitDurableSessionState(ctx.state, candidate);
            return successMessage;
        });
    }
    const params = getCurrentParams(ctx.state, ctx.messages, ctx.logger);
    await sendIgnoredMessage(ctx.client, ctx.sessionId, response, params, ctx.logger);
}
//# sourceMappingURL=auto.js.map