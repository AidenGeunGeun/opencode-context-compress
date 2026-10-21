import type { SessionState, WithParts } from "../state/index.js";
/**
 * Whether the transient post-compression notice is still due for this request.
 *
 * Derived on every transform rather than tracked with a consume-once flag: a request that
 * fails or is rebuilt would clear such a flag and silently lose the notice, while
 * recomputing simply returns the same answer again.
 *
 * Must be evaluated against the RAW messages, before compression transforms run - cleanup
 * can suppress the compressing message itself once a later user message bounds its span.
 * Evaluation is at part granularity because the `compress` call and its same-step siblings
 * share one assistant message.
 */
export declare function isPostCompressionNoticeDue(state: SessionState, rawMessages: WithParts[]): boolean;
//# sourceMappingURL=post-compression-notice.d.ts.map