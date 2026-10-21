import { z } from "zod";

export const GUARD_HOOK_KINDS = ["PreToolUse", "PostToolUse", "Stop"] as const;
export type GuardHookKind = (typeof GUARD_HOOK_KINDS)[number];

export const GUARD_DECISIONS = ["allow", "ask", "deny"] as const;
export type GuardDecision = (typeof GUARD_DECISIONS)[number];

/**
 * What a hook script posts to `guard/evaluate`. Deliberately thin: no tool
 * input/output payload travels in this body. `excerpt` is the only free-text
 * field; it is capped here, then redacted and truncated again by
 * `JevClient.ask` (same pipeline every other policy's state goes through)
 * before it ever reaches Jev, and it never reaches the ledger — only the
 * resulting decision, confidence, and latency are stored.
 */
export const guardEvaluateRequestSchema = z.object({
  hookKind: z.enum(GUARD_HOOK_KINDS),
  runId: z.string().min(1),
  toolName: z.string().min(1).optional(),
  /** Stable hash of the tool call's canonicalized input, computed by the
   * hook script. Used for the loop guard and cache keying — never the raw
   * input itself. */
  toolInputHash: z.string().min(1).optional(),
  issueId: z.string().optional(),
  /** Bounded, pre-truncated excerpt describing the call: the tool input
   * (`PreToolUse`), the tool's observed output (`PostToolUse`), or the
   * agent's final message (`Stop`). The hook script truncates this before
   * sending; the plugin redacts and truncates it again (same pipeline every
   * other policy's state goes through, see `JevClient.ask`) before it ever
   * reaches Jev, and it is never written to the ledger — only the resulting
   * decision, confidence, and latency are stored. Capped well below the
   * client's own truncation so a hostile tool can't force an oversized body
   * through the route. */
  excerpt: z.string().max(4_000).optional(),
  /**
   * Id of an accepted `request_confirmation` issue-thread interaction that
   * pre-cleared this exact call (the agent requests it via Paperclip's own
   * interaction primitive, a human accepts it on the board, then the agent
   * passes its id here). Verified server-side against
   * `ctx.issues.listInteractions` — the plugin never trusts this field on
   * its own. See docs/SECURITY.md.
   */
  overrideInteractionId: z.string().optional(),
});
export type GuardEvaluateRequest = z.infer<typeof guardEvaluateRequestSchema>;

export interface GuardEvaluateResult {
  decision: GuardDecision;
  /** Short machine reason code, same contract as `PolicyVerdict.reason`. */
  reason: string;
  confidence: number | null;
  latencyMs: number;
  /** `true` when a deterministic rail decided this without calling Jev. */
  rail: boolean;
  /** Decision the policy would have made before the current policy `mode`
   * downgraded it (e.g. a `deny` intent recorded while `mode: "shadow"`
   * still returns `allow`). Surfaced so shadow-mode false-positive rate can
   * be measured without promoting the policy first. */
  intendedDecision: GuardDecision;
}
