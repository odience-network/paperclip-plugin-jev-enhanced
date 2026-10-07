import type { JevClient } from "../jev/client.js";
import type { JevAnswer } from "../jev/types.js";
import { classifyError } from "../jev/errors.js";
import { beginDecision, completeDecision, type DecisionOutcome, type LedgerDb } from "../ledger/index.js";
import { policyConfigFor, type JevConfig, type PolicyMode } from "../config.js";
import { applyDecision, type ApplyDeps } from "../apply/index.js";
import { postSuggestion, type SuggestDeps } from "../suggest/index.js";
import { hashState } from "../jev/redact.js";
import type { Policy, PolicyContext, PolicyVerdict } from "./types.js";

export interface RunPolicyInput<TState> {
  policy: Policy<TState>;
  state: TState;
  config: JevConfig;
  companyId: string;
  issueId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  /** The previous decision's `stateHash` for this issue (from the ledger),
   * if the caller already looked one up. Threaded into `ctx.priorStateHash`
   * so a policy's `preFilter` can skip re-asking Jev about unchanged state. */
  priorStateHash?: string | null;
}

export interface RunPolicyDeps {
  client: JevClient;
  db: LedgerDb;
  apply: ApplyDeps;
  suggest: SuggestDeps;
}

export type RunPolicyResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: DecisionOutcome; decisionId: string; verdict: PolicyVerdict; cached: boolean };

/** Mode governs what a decision is *allowed* to do, never whether it is
 * recorded — every mode writes a decision row via `beginDecision`. */
function outcomeForMode(mode: PolicyMode): DecisionOutcome {
  switch (mode) {
    case "shadow":
      return "observed";
    case "suggest":
      return "suggested";
    case "enforce":
      return "applied";
  }
}

/**
 * Orchestrates one policy evaluation end to end: resolves company config,
 * writes the audit row *before* the provider call, calls Jev, decides, then
 * completes the audit row with the real outcome — and only runs `src/apply/`
 * side effects when the policy's mode is `enforce`.
 */
export async function runPolicy<TState>(
  input: RunPolicyInput<TState>,
  deps: RunPolicyDeps,
): Promise<RunPolicyResult> {
  const policyConfig = policyConfigFor(input.config, input.policy.name);
  const ctx: PolicyContext = {
    companyId: input.companyId,
    issueId: input.issueId ?? null,
    runId: input.runId ?? null,
    agentId: input.agentId ?? null,
    config: policyConfig,
    respectExistingFields: input.config.respectExistingFields,
    alwaysAuto: policyConfig.alwaysAuto,
    stateHash: hashState(
      input.policy.identityState ? input.policy.identityState(input.state) : input.state,
      input.config.redactionPatterns,
    ),
    priorStateHash: input.priorStateHash ?? null,
  };

  if (!policyConfig.enabled) {
    return { outcome: "skipped", reason: "policy-disabled" };
  }
  if (!input.policy.preFilter(input.state, ctx)) {
    return { outcome: "skipped", reason: "pre-filter" };
  }

  const decisionId = await beginDecision(deps.db, {
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    agentId: input.agentId,
    policy: input.policy.name,
    policyVersion: input.policy.version,
    questionVersion: input.policy.questionVersion,
    model: deps.client.resolvedModel,
    mode: policyConfig.mode,
  });

  try {
    const questions = input.policy.questions(input.state, ctx);
    const askOutcome = await deps.client.ask({
      policy: input.policy.name,
      companyId: input.companyId,
      state: input.state,
      questions,
    });
    const answers = askOutcome.result.answers as Record<string, JevAnswer>;
    const verdict = input.policy.decide(answers, ctx, input.state);
    const outcome = outcomeForMode(policyConfig.mode);

    await completeDecision(deps.db, decisionId, {
      // The ledger persists the *identity* hash (`ctx.stateHash`), not
      // `askOutcome.stateHash` (which hashes the full, noisy state sent to
      // the provider and exists only to key the response cache) — this is
      // the value `priorStateHash` compares against on the next run, so it
      // must be the same stable projection `preFilter` used above.
      stateHash: ctx.stateHash ?? askOutcome.stateHash,
      answers,
      confidence: verdict.confidence,
      margin: verdict.margin,
      latencyMs: askOutcome.latencyMs,
      usage: askOutcome.result.usage,
      costUsd: askOutcome.costUsd,
      outcome,
      reason: verdict.reason,
    });

    if (outcome === "applied") {
      await applyDecision({ policy: input.policy.name, verdict, ctx, state: input.state }, deps.apply);
    } else if (outcome === "suggested") {
      await postSuggestion({ policy: input.policy.name, verdict, ctx }, deps.suggest);
    }

    return { outcome, decisionId, verdict, cached: askOutcome.cached };
  } catch (error) {
    await completeDecision(deps.db, decisionId, {
      stateHash: "",
      answers: {},
      confidence: null,
      margin: null,
      latencyMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      outcome: "error",
      reason: classifyError(error),
    });
    throw error;
  }
}
