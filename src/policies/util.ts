import type { JevAnswer } from "../jev/types.js";

/** Collapses any `JevAnswer` shape to a single `{confidence, margin}` pair so
 * `decide()` implementations can gate on the same two numbers regardless of
 * whether the underlying question was `noul`, `choice`, or `score`. Shared
 * across every policy's `decide()` — see `issue-triage.ts` for the original,
 * and `ask.ts`/`classify-task.ts`/`verify.ts`/`rerank.ts` for the generic
 * decision tools that also use it. */
export function confidenceMarginFor(answer: JevAnswer | undefined): { confidence: number; margin: number } | null {
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
