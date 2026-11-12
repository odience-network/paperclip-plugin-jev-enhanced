import type { VerdictAnswer } from "../decision/types.js";

/** Collapses any `VerdictAnswer` shape to a single `{confidence, margin}` pair so
 * `decide()` implementations can gate on the same two numbers regardless of
 * whether the underlying question was `noul`, `choice`, or `score`. Shared
 * across every policy's `decide()` — see `issue-triage.ts` for the original,
 * and `ask.ts`/`classify-task.ts`/`verify.ts`/`rerank.ts` for the generic
 * decision tools that also use it. */
export function confidenceMarginFor(answer: VerdictAnswer | undefined): { confidence: number; margin: number } | null {
  if (!answer) return null;
  if (answer.type === "noul") {
    return { confidence: Math.max(answer.noul, 1 - answer.noul), margin: Math.abs(2 * answer.noul - 1) };
  }
  if (answer.type === "choice" || answer.type === "score") {
    const sorted = Object.values(answer.probabilities).sort((a, b) => b - a);
    const margin = sorted.length >= 2 ? sorted[0] - sorted[1] : sorted[0] ?? 0;
    return { confidence: answer.confidence, margin };
  }
  return null;
}

/** Where a comment came from. `"fast_response"` is core's one-sentence
 * acknowledgement receipt (paperclipai/paperclip #15748), posted as the
 * assigned agent whenever a human comments — it is never the agent's own
 * work, claim, or question. */
export type CommentOrigin = "comment" | "fast_response";

/** Reads a host comment's server-owned `origin`. Older cores (and the
 * `@paperclipai/shared` build this plugin compiles against) omit the field,
 * so anything other than `"fast_response"` is an ordinary `"comment"`. */
export function commentOriginOf(comment: object): CommentOrigin {
  return (comment as { origin?: unknown }).origin === "fast_response" ? "fast_response" : "comment";
}

/** The one rule every comment reader in this plugin applies: a fast-response
 * receipt is never classified, never counted as a run's final comment, and
 * never fed to a provider. See ARCHITECTURE.md "Comment origin". */
export function isFastResponseReceipt(comment: object): boolean {
  return commentOriginOf(comment) === "fast_response";
}
