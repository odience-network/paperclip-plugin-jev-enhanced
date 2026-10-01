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
}

export interface PolicyVerdict {
  /** Policy-specific label, e.g. `"pong"` or `"allow"` / `"deny"`. */
  verdict: string;
  confidence: number | null;
  margin: number | null;
  /** Short machine reason code — never issue free text. */
  reason: string;
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
  questions(state: TState, ctx: PolicyContext): Questions;
  decide(answers: Record<string, JevAnswer>, ctx: PolicyContext): PolicyVerdict;
}
