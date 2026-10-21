import type { PolicyMode } from "../config.js";
import type { GuardDecision } from "./types.js";

/**
 * Maps an intended guard decision to what the hook actually receives, given
 * the policy's current `mode`. Mirrors `outcomeForMode` in
 * `src/policies/run.ts` (mode governs what a decision is *allowed* to do,
 * never whether it's recorded) but for a decision space of `allow/ask/deny`
 * instead of an audit outcome:
 *
 * - `shadow`: never blocks. Always returns `allow`; the intended decision is
 *   still recorded so `eval-guard` can measure false positives before promotion.
 * - `suggest`: never hard-blocks. `deny` is downgraded to `ask` (a human is
 *   asked to confirm) so the first mode a guard can cause real friction in
 *   is `enforce`.
 * - `enforce`: the intended decision is returned verbatim, including `deny`.
 */
export function effectiveDecision(mode: PolicyMode, intended: GuardDecision): GuardDecision {
  switch (mode) {
    case "shadow":
      return "allow";
    case "suggest":
      return intended === "deny" ? "ask" : intended;
    case "enforce":
      return intended;
  }
}
