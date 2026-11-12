import type { VerdictConfig, PolicyMode } from "../config.js";
import { answeredByFields, type DecisionPipeline } from "../decision/pipeline.js";
import type { LedgerDb } from "../ledger/db.js";
import { beginDecision, completeDecision, type DecisionOutcome } from "../ledger/decisions.js";
import { policyConfigFor } from "../config.js";
import { classifyError } from "../decision/errors.js";
import type { VerdictAskOutcome } from "../decision/pipeline.js";
import { providerBinding } from "../decision/registry.js";
import { CORE_GOVERNED_TOOL_REASON, guardPrePolicy, isCoreGovernedTool, type GuardPreState } from "./pre.js";
import { guardPostPolicy, type GuardPostState } from "./post.js";
import { guardStopPolicy, type GuardStopState } from "./stop.js";
import { runRails, type RailDeps } from "./rails.js";
import { effectiveDecision } from "./mode.js";
import type { GuardDecision, GuardEvaluateRequest, GuardEvaluateResult, GuardHookKind } from "./types.js";
import type { Policy, PolicyContext, PolicyVerdict } from "../policies/types.js";

export interface EvaluateGuardDeps {
  client: DecisionPipeline;
  db: LedgerDb;
  rails: RailDeps;
  config: VerdictConfig;
  companyId: string;
  agentId?: string | null;
  /** Issue title/description for `PreToolUse`'s `on_task` and `Stop`'s
   * completion-evidence question. `null`/absent when no issue is in scope. */
  issue?: { title: string; description: string | null } | null;
}

export const POLICY_FOR_HOOK: Record<GuardHookKind, Policy<any>> = {
  PreToolUse: guardPrePolicy,
  PostToolUse: guardPostPolicy,
  Stop: guardStopPolicy,
};

/** On a provider timeout or error: a `shadow`/`suggest` policy can't deny anyway,
 * so failing to `allow` changes nothing observable — "fail-open for
 * observation/routing". `Stop` has no `deny` in its decision space at all.
 * Only an `enforce`-mode Pre/Post call can actually block work, so that's
 * the only case that fails closed — to `ask`, never a silent `allow` and
 * never a `deny` manufactured purely from an infra failure (which would
 * itself be a DoS lever against the whole run). */
export function fallbackDecision(hookKind: GuardHookKind, mode: PolicyMode): GuardDecision {
  if (mode !== "enforce") return "allow";
  if (hookKind === "Stop") return "allow";
  return "ask";
}

/** `bypassMode` is `true` only for rail verdicts (kill switch, blocklist,
 * loop guard) that `evaluateGuard` applied without going through
 * `effectiveDecision` — those are real enforced outcomes (`blocked`/
 * `applied`) in every mode, not merely `observed`/`suggested`, because the
 * whole point of a `bypassMode` rail is that it isn't subject to the
 * policy's mode in the first place. */
function outcomeFor(mode: PolicyMode, finalDecision: GuardDecision, bypassMode = false): DecisionOutcome {
  if (!bypassMode) {
    if (mode === "shadow") return "observed";
    if (mode === "suggest") return "suggested";
  }
  return finalDecision === "deny" ? "blocked" : "applied";
}

function buildState(
  hookKind: GuardHookKind,
  request: GuardEvaluateRequest,
  issue: EvaluateGuardDeps["issue"],
): GuardPreState | GuardPostState | GuardStopState {
  if (hookKind === "PreToolUse") {
    return {
      toolName: request.toolName ?? "",
      excerpt: request.excerpt,
      issueTitle: issue?.title,
      issueDescription: issue?.description ?? undefined,
    } satisfies GuardPreState;
  }
  if (hookKind === "PostToolUse") {
    return { toolName: request.toolName ?? "", excerpt: request.excerpt ?? "" } satisfies GuardPostState;
  }
  return {
    excerpt: request.excerpt ?? "",
    issueTitle: issue?.title,
    issueDescription: issue?.description ?? undefined,
  } satisfies GuardStopState;
}

interface AskResolution {
  verdict: PolicyVerdict;
  outcome: VerdictAskOutcome;
  /** The policy's mode as bound to the provider that actually answered. */
  mode: PolicyMode;
}

type RaceResult = { status: "ok"; value: AskResolution } | { status: "error"; error: unknown } | { status: "timeout" };

/** Races the provider call against the time budget without ever producing an
 * unhandled rejection: the underlying call's eventual success/failure is
 * always observed by exactly one of `raceWithTimeout`'s own branches or the
 * `onLate` callback passed in when the timeout wins. */
function raceWithTimeout(
  run: () => Promise<AskResolution>,
  timeBudgetMs: number,
  onLate: (result: RaceResult) => void,
): Promise<RaceResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: "timeout" });
    }, timeBudgetMs);

    run()
      .then((value) => {
        const result: RaceResult = { status: "ok", value };
        if (settled) {
          onLate(result);
        } else {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      })
      .catch((error) => {
        const result: RaceResult = { status: "error", error };
        if (settled) {
          onLate(result);
        } else {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      });
  });
}

/**
 * Orchestrates one `guard/evaluate` call: rails first (no provider call if a rail
 * decides), then the hook-kind-specific policy under a wall-clock budget,
 * then downgrades the intended decision per the policy's `mode`. Always
 * writes exactly one ledger row (via `beginDecision`/`completeDecision`),
 * same contract as `runPolicy` — tool name, decision, confidence, latency;
 * never the request's `excerpt`.
 */
export async function evaluateGuard(request: GuardEvaluateRequest, deps: EvaluateGuardDeps): Promise<GuardEvaluateResult> {
  const started = Date.now();
  const policy = POLICY_FOR_HOOK[request.hookKind];
  const primary = deps.client.primary;
  const policyConfig = policyConfigFor(deps.config, policy.name, providerBinding(primary));
  const ctx: PolicyContext = {
    companyId: deps.companyId,
    issueId: request.issueId ?? null,
    runId: request.runId,
    agentId: deps.agentId ?? null,
    config: policyConfig,
  };

  // MCP tools are core's tool gateway's to govern, so this runs before every
  // rail (kill switch, blocklist, loop guard included): VerdictGuard must not
  // override a core trust rule or add a second prompt next to a core approval
  // card. `bypassMode` so the row reads `applied` in every mode — this is a
  // scope boundary, not a policy verdict the mode could downgrade.
  if (request.hookKind !== "Stop" && isCoreGovernedTool(request.toolName)) {
    await recordRailOnlyDecision(deps, request, policy, policyConfig.mode, "allow", CORE_GOVERNED_TOOL_REASON, true);
    return {
      decision: "allow",
      reason: CORE_GOVERNED_TOOL_REASON,
      confidence: null,
      latencyMs: Date.now() - started,
      rail: true,
      intendedDecision: "allow",
    };
  }

  const railVerdict = await runRails(request, deps.companyId, deps.config.guardRails, deps.rails);
  if (railVerdict) {
    // `bypassMode` rails (kill switch, blocklist, loop guard) apply verbatim —
    // never downgraded by `effectiveDecision` — so a `shadow`-mode policy
    // (the shipped default) can't silently turn their `deny` into an `allow`.
    const finalDecision = railVerdict.bypassMode ? railVerdict.decision : effectiveDecision(policyConfig.mode, railVerdict.decision);
    await recordRailOnlyDecision(deps, request, policy, policyConfig.mode, finalDecision, railVerdict.reason, railVerdict.bypassMode);
    return {
      decision: finalDecision,
      reason: railVerdict.reason,
      confidence: null,
      latencyMs: Date.now() - started,
      rail: true,
      intendedDecision: railVerdict.decision,
    };
  }

  if (!policyConfig.enabled) {
    return {
      decision: "allow",
      reason: "policy-disabled",
      confidence: null,
      latencyMs: Date.now() - started,
      rail: true,
      intendedDecision: "allow",
    };
  }

  const state = buildState(request.hookKind, request, deps.issue);
  const decisionId = await beginDecision(deps.db, {
    companyId: deps.companyId,
    issueId: request.issueId,
    runId: request.runId,
    agentId: deps.agentId,
    policy: policy.name,
    policyVersion: policy.version,
    questionVersion: policy.questionVersion,
    model: primary.model,
    mode: policyConfig.mode,
    toolName: request.toolName ?? null,
    provider: primary.id,
    providerKind: primary.kind,
  });

  const fallback = fallbackDecision(request.hookKind, policyConfig.mode);

  const runAsk = async (): Promise<AskResolution> => {
    const questions = policy.questions(state, ctx);
    const outcome = await deps.client.ask({ policy: policy.name, companyId: deps.companyId, state, questions });
    if (outcome.provider === primary) {
      return { verdict: policy.decide(outcome.result.answers, ctx), outcome, mode: policyConfig.mode };
    }
    const answeredConfig = policyConfigFor(deps.config, policy.name, providerBinding(outcome.provider));
    const verdict = policy.decide(outcome.result.answers, { ...ctx, config: answeredConfig });
    return { verdict, outcome, mode: answeredConfig.mode };
  };

  const onLate = (result: RaceResult) => {
    void completeFromLateResult(deps, decisionId, result);
  };

  const raced = await raceWithTimeout(runAsk, deps.config.guardRails.timeBudgetMs, onLate);

  if (raced.status === "timeout") {
    return {
      decision: fallback,
      reason: "time-budget-exceeded",
      confidence: null,
      latencyMs: Date.now() - started,
      rail: false,
      intendedDecision: fallback,
    };
  }

  if (raced.status === "error") {
    await completeDecision(deps.db, decisionId, errorPatch(started, raced.error));
    return {
      decision: fallback,
      reason: classifyError(raced.error),
      confidence: null,
      latencyMs: Date.now() - started,
      rail: false,
      intendedDecision: fallback,
    };
  }

  const { verdict, outcome, mode } = raced.value;
  const intended = verdict.verdict as GuardDecision;
  const finalDecision = effectiveDecision(mode, intended);
  await completeDecision(deps.db, decisionId, {
    stateHash: outcome.stateHash,
    answers: {},
    confidence: verdict.confidence,
    margin: verdict.margin,
    latencyMs: outcome.latencyMs,
    usage: outcome.result.usage,
    costUsd: outcome.costUsd,
    outcome: outcomeFor(mode, finalDecision),
    reason: verdict.reason,
    ...answeredByFields(outcome),
    ...(mode !== policyConfig.mode ? { mode } : {}),
  });
  return {
    decision: finalDecision,
    reason: verdict.reason,
    confidence: verdict.confidence,
    latencyMs: Date.now() - started,
    rail: false,
    intendedDecision: intended,
  };
}

function errorPatch(started: number, error: unknown) {
  return {
    stateHash: "",
    answers: {},
    confidence: null,
    margin: null,
    latencyMs: Date.now() - started,
    usage: { input_tokens: 0, output_tokens: 0 },
    costUsd: 0,
    outcome: "error" as const,
    reason: classifyError(error),
  };
}

async function recordRailOnlyDecision(
  deps: EvaluateGuardDeps,
  request: GuardEvaluateRequest,
  policy: Policy<any>,
  mode: PolicyMode,
  finalDecision: GuardDecision,
  reason: string,
  bypassMode = false,
): Promise<void> {
  const decisionId = await beginDecision(deps.db, {
    companyId: deps.companyId,
    issueId: request.issueId,
    runId: request.runId,
    agentId: deps.agentId,
    policy: policy.name,
    policyVersion: policy.version,
    questionVersion: policy.questionVersion,
    model: "rails-only",
    mode,
    toolName: request.toolName ?? null,
    provider: deps.client.primary.id,
    providerKind: deps.client.primary.kind,
  });
  await completeDecision(deps.db, decisionId, {
    stateHash: "",
    answers: {},
    confidence: null,
    margin: null,
    latencyMs: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    costUsd: 0,
    outcome: outcomeFor(mode, finalDecision, bypassMode),
    reason,
  });
}

/** Completes the ledger row for a provider call that finished (or failed) after
 * the route had already returned the time-budget fallback to the caller. */
async function completeFromLateResult(
  deps: EvaluateGuardDeps,
  decisionId: string,
  result: RaceResult,
): Promise<void> {
  if (result.status === "timeout") return;
  if (result.status === "error") {
    await completeDecision(deps.db, decisionId, errorPatch(Date.now(), result.error));
    return;
  }
  const { verdict, outcome, mode } = result.value;
  const finalDecision = effectiveDecision(mode, verdict.verdict as GuardDecision);
  await completeDecision(deps.db, decisionId, {
    stateHash: outcome.stateHash,
    answers: {},
    confidence: verdict.confidence,
    margin: verdict.margin,
    latencyMs: outcome.latencyMs,
    usage: outcome.result.usage,
    costUsd: outcome.costUsd,
    outcome: outcomeFor(mode, finalDecision),
    reason: `${verdict.reason}-after-timeout`,
    ...answeredByFields(outcome),
  });
}
