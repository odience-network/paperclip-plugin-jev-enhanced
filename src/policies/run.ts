import { answeredByFields, type DecisionPipeline, type VerdictAskInput } from "../decision/pipeline.js";
import type { VerdictAnswer } from "../decision/types.js";
import { CapabilityError, classifyError, errorClassOf } from "../decision/errors.js";
import { providerBinding } from "../decision/registry.js";
import { beginDecision, completeDecision, type DecisionOutcome, type LedgerDb } from "../ledger/index.js";
import { policyConfigFor, type VerdictConfig, type PolicyMode } from "../config.js";
import { applyDecision, type ApplyDeps } from "../apply/index.js";
import { postSuggestion, type SuggestDeps } from "../suggest/index.js";
import { hashState } from "../decision/redact.js";
import type { Policy, PolicyContext, PolicyVerdict } from "./types.js";

export interface RunPolicyInput<TState> {
  policy: Policy<TState>;
  state: TState;
  config: VerdictConfig;
  companyId: string;
  issueId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  /** The previous decision's `stateHash` for this issue (from the ledger),
   * if the caller already looked one up. Threaded into `ctx.priorStateHash`
   * so a policy's `preFilter` can skip re-asking the provider about unchanged state. */
  priorStateHash?: string | null;
}

export interface RunPolicyDeps {
  client: DecisionPipeline;
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
 * Asks every shadow provider the same question set as the primary, each
 * alone (`askShadow`: no fallback), and records each as its own `shadow`-mode
 * row under the primary's `decision_group_id`. Rows are written before the
 * calls, like the primary's. A shadow's verdict is computed with its own
 * provider-bound thresholds, recorded, and never applied or suggested. Never
 * throws: a shadow failure is an `error` row with its `error_class`, nothing
 * more.
 */
async function runShadows<TState>(
  input: RunPolicyInput<TState>,
  deps: RunPolicyDeps,
  ctx: PolicyContext,
  primaryDecisionId: string,
  askInput: VerdictAskInput,
): Promise<void> {
  const shadows = deps.client.shadows;
  if (shadows.length === 0) return;
  await Promise.all(
    shadows.map(async (provider) => {
      let decisionId: string | null = null;
      try {
        const shadowConfig = policyConfigFor(input.config, input.policy.name, providerBinding(provider));
        decisionId = await beginDecision(deps.db, {
          companyId: input.companyId,
          issueId: input.issueId,
          runId: input.runId,
          agentId: input.agentId,
          policy: input.policy.name,
          policyVersion: input.policy.version,
          questionVersion: input.policy.questionVersion,
          model: provider.model,
          mode: "shadow",
          provider: provider.id,
          providerKind: provider.kind,
          decisionGroupId: primaryDecisionId,
        });
        const askOutcome = await deps.client.askShadow(provider, askInput);
        const answers = askOutcome.result.answers as Record<string, VerdictAnswer>;
        const verdict = input.policy.decide(answers, { ...ctx, config: shadowConfig, alwaysAuto: shadowConfig.alwaysAuto }, input.state);
        await completeDecision(deps.db, decisionId, {
          stateHash: ctx.stateHash ?? askOutcome.stateHash,
          answers,
          confidence: verdict.confidence,
          margin: verdict.margin,
          latencyMs: askOutcome.latencyMs,
          usage: askOutcome.result.usage,
          costUsd: askOutcome.costUsd,
          outcome: "observed",
          reason: verdict.reason,
          ...answeredByFields(askOutcome),
        });
      } catch (error) {
        if (!decisionId) return;
        const skipped = error instanceof CapabilityError;
        await completeDecision(deps.db, decisionId, {
          stateHash: ctx.stateHash ?? "",
          answers: {},
          confidence: null,
          margin: null,
          latencyMs: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          costUsd: 0,
          outcome: skipped ? "skipped" : "error",
          reason: classifyError(error),
          errorClass: skipped ? null : errorClassOf(error),
        }).catch(() => undefined);
      }
    }),
  );
}

/**
 * Orchestrates one policy evaluation end to end: resolves company config
 * (thresholds and mode bound to the policy's primary provider), writes the
 * audit row *before* the provider call, calls the provider chain, decides,
 * then completes the audit row with the real outcome — and only runs
 * `src/apply/` side effects when the policy's effective mode is `enforce`.
 *
 * If a fallback provider answered, config is re-resolved for it, so a
 * fallback that isn't calibrated for this policy can only ever observe. If no
 * provider in the chain can take the question set, the row is `skipped` with
 * the capability reason code instead of `error`.
 *
 * Configured shadow providers are asked concurrently with the primary and
 * recorded under its `decision_group_id` (see `runShadows`); they never change
 * the applied action, and the call returns once they have been recorded.
 */
export async function runPolicy<TState>(
  input: RunPolicyInput<TState>,
  deps: RunPolicyDeps,
): Promise<RunPolicyResult> {
  const primary = deps.client.primary;
  const policyConfig = policyConfigFor(input.config, input.policy.name, providerBinding(primary));
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
    model: primary.model,
    mode: policyConfig.mode,
    provider: primary.id,
    providerKind: primary.kind,
  });

  let shadowRun: Promise<void> = Promise.resolve();
  try {
    const askInput: VerdictAskInput = {
      policy: input.policy.name,
      companyId: input.companyId,
      state: input.state,
      questions: input.policy.questions(input.state, ctx),
      choiceRanking: input.policy.rankChoices?.(input.state, ctx),
    };
    shadowRun = runShadows(input, deps, ctx, decisionId, askInput);
    const askOutcome = await deps.client.ask(askInput);
    const answeredBy = askOutcome.provider;
    const answeredConfig =
      answeredBy === primary ? policyConfig : policyConfigFor(input.config, input.policy.name, providerBinding(answeredBy));
    const answeredCtx: PolicyContext =
      answeredConfig === policyConfig ? ctx : { ...ctx, config: answeredConfig, alwaysAuto: answeredConfig.alwaysAuto };
    const answers = askOutcome.result.answers as Record<string, VerdictAnswer>;
    const verdict = input.policy.decide(answers, answeredCtx, input.state);
    const outcome = outcomeForMode(answeredConfig.mode);

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
      ...answeredByFields(askOutcome),
      ...(answeredConfig.mode !== policyConfig.mode ? { mode: answeredConfig.mode } : {}),
    });

    if (outcome === "applied") {
      await applyDecision({ policy: input.policy.name, verdict, ctx: answeredCtx, state: input.state }, deps.apply);
    } else if (outcome === "suggested") {
      await postSuggestion({ policy: input.policy.name, verdict, ctx: answeredCtx }, deps.suggest);
    }

    await shadowRun;
    return { outcome, decisionId, verdict, cached: askOutcome.cached };
  } catch (error) {
    await shadowRun;
    const skipped = error instanceof CapabilityError;
    await completeDecision(deps.db, decisionId, {
      stateHash: "",
      answers: {},
      confidence: null,
      margin: null,
      latencyMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      outcome: skipped ? "skipped" : "error",
      reason: classifyError(error),
      errorClass: skipped ? null : errorClassOf(error),
    });
    if (skipped) return { outcome: "skipped", reason: error.reason };
    throw error;
  }
}
