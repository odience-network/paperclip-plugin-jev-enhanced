import type { Questions } from "@typesafe-ai/sdk";
import type { JevAnswer } from "../jev/types.js";
import type { PolicyConfig, PolicyMode } from "../config.js";

export interface PolicyContext {
  companyId: string;
  issueId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  /** Resolved `{enabled, mode, thresholds}` for this policy from company config. */
  config: PolicyConfig;
  /** Top-level `JevConfig.respectExistingFields` for this company. A policy
   * that patches real issue fields must not overwrite one a human already
   * set while this is `true`, unless `alwaysAuto` is also `true`. Treated as
   * `true` (the safe default) when a caller doesn't thread it through. */
  respectExistingFields?: boolean;
  /** Per-policy operator override (`PolicyConfig.alwaysAuto`): lets `enforce`
   * mode overwrite an existing human-set field anyway. Never lets a policy
   * write `assigneeUserId` — that rule has no override. */
  alwaysAuto?: boolean;
  /** SHA-256 hash of the canonicalized state this decision is about to send
   * (same pipeline `JevClient.ask()` uses), precomputed by the caller so
   * `preFilter` can dedupe without an extra provider round trip. */
  stateHash?: string | null;
  /** The previous decision's `stateHash` for this issue, from the ledger, if
   * any. `null`/`undefined` means no prior decision was found. */
  priorStateHash?: string | null;
}

/** One field a multi-question policy proposed or applied, alongside its own
 * per-field confidence/margin — `ping`/single-question policies never set
 * `PolicyVerdict.fields` and keep using the top-level `confidence`/`margin`. */
export interface FieldDecision {
  field: string;
  value: unknown;
  confidence: number;
  margin: number;
  /** `"apply"` when thresholds clear the bar and mode allows a host-side
   * mutation; `"suggest"` when it's only proposed to a human; `"observe"`
   * when the field has no host-side effect at all (e.g. no native Issue
   * field to patch) and only ever lands in the ledger. */
  action: "apply" | "suggest" | "observe";
  /** Why `action` isn't `"apply"` even though the policy answered this
   * field — e.g. `"below-threshold"`, `"respects-existing-field"`,
   * `"no-applicable-field"`. Omitted when `action` is `"apply"`. */
  reason?: string;
}

export interface PolicyVerdict {
  /** Policy-specific label, e.g. `"pong"` or `"allow"` / `"deny"`. */
  verdict: string;
  confidence: number | null;
  margin: number | null;
  /** Short machine reason code — never issue free text. */
  reason: string;
  /** Per-field breakdown for a multi-question policy (e.g. `issue-triage`).
   * Absent for single-verdict policies like `ping`. */
  fields?: FieldDecision[];
}

/**
 * The shape every policy implements: a local `preFilter` that can skip a
 * provider call entirely, `questions` that describe what to ask Jev, and
 * `decide` that interprets the answers against this company's thresholds.
 * Side effects of an `enforce`-mode decision belong in `src/apply/`, never here.
 */
export interface Policy<TState = unknown> {
  name: string;
  version: string;
  questionVersion: string;
  /** Mode a freshly-configured company starts in. Config can raise this once
   * an eval report clears the bar — never read `process.env` or hardcode `enforce`. */
  defaultMode: PolicyMode;
  preFilter(state: TState, ctx: PolicyContext): boolean;
  /** Projects `state` down to the stable, issue-intrinsic subset that should
   * invalidate `ctx.stateHash`'s dedup check — e.g. drop fields that are
   * derived from the ledger (like "is this the first triage") or that churn
   * on unrelated company activity (like full candidate objects) while
   * keeping the sorted candidate-id sets whose *membership* changing should
   * still re-trigger a decision. Defaults to hashing the full state when a
   * policy doesn't define this. */
  identityState?(state: TState): unknown;
  questions(state: TState, ctx: PolicyContext): Questions;
  /** `state` is the same value passed to `questions`/`preFilter`, threaded
   * through so a multi-question policy can gate on candidate-set size (e.g.
   * "state size < C") without the framework needing a dedicated field for
   * it. Optional so single-question policies like `ping` can ignore it. */
  decide(answers: Record<string, JevAnswer>, ctx: PolicyContext, state?: TState): PolicyVerdict;
}
