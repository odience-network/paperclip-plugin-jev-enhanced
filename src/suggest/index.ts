import type { FieldDecision, PolicyContext, PolicyVerdict } from "../policies/types.js";

export interface SuggestInput {
  policy: string;
  verdict: PolicyVerdict;
  ctx: PolicyContext;
}

export interface SuggestDeps {
  /** Injected so side effects (posting a board-facing confirmation) go
   * through `ctx`-scoped host APIs rather than any ambient client — mirrors
   * `ApplyDeps` in `src/apply/`. */
  log: (message: string, fields?: Record<string, unknown>) => void;
  requestConfirmation?: (input: {
    issueId: string;
    companyId: string;
    prompt: string;
    detailsMarkdown: string;
    idempotencyKey: string;
  }) => Promise<void>;
}

export type SuggestFn = (input: SuggestInput, deps: SuggestDeps) => Promise<void>;

/**
 * All side effects of a `suggest`-mode decision live here, never in
 * `src/policies/`. The `ping` reference policy has nothing to suggest.
 */
async function suggestPing(input: SuggestInput, deps: SuggestDeps): Promise<void> {
  deps.log("jev.suggest.ping", { verdict: input.verdict.verdict, issueId: input.ctx.issueId ?? null });
}

function describeField(field: FieldDecision): string {
  const pct = `${Math.round(field.confidence * 100)}%`;
  return `- **${field.field}**: \`${JSON.stringify(field.value)}\` (confidence ${pct}, margin ${field.margin.toFixed(2)})`;
}

/**
 * Posts one `request_confirmation` per issue bundling every field the policy
 * answered, actionable or not — `fits_project`, `duplicateOf`, `complexity`,
 * etc. have no native field to patch, so a human reading the card is the only
 * way they ever reach a decision-maker. Fields `decide()` already blocked
 * from applying (below threshold, or guarded by `respectExistingFields`)
 * are still listed, so a reviewer can see what Jev would have done.
 */
async function suggestIssueTriage(input: SuggestInput, deps: SuggestDeps): Promise<void> {
  const issueId = input.ctx.issueId;
  const fields = input.verdict.fields ?? [];
  if (!issueId || !deps.requestConfirmation || fields.length === 0) {
    deps.log("jev.suggest.issue-triage.no-op", {
      reason: !issueId ? "no-issue-id" : !deps.requestConfirmation ? "no-request-confirmation-dep" : "no-fields",
    });
    return;
  }

  const actionable = fields.filter((f) => f.action === "apply" || f.action === "suggest");
  const observedOnly = fields.filter((f) => f.action === "observe");
  const detailsMarkdown = [
    actionable.length > 0 ? "### Proposed changes" : "",
    ...actionable.map(describeField),
    observedOnly.length > 0 ? "### For your information" : "",
    ...observedOnly.map(describeField),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  await deps.requestConfirmation({
    issueId,
    companyId: input.ctx.companyId,
    prompt: "Jev triaged this issue. Apply the proposed fields?",
    detailsMarkdown,
    idempotencyKey: `jev:issue-triage:${issueId}:${input.ctx.stateHash ?? "unknown"}`,
  });
  deps.log("jev.suggest.issue-triage", { issueId, fieldCount: fields.length });
}

/** `ask`/`classify-task`/`verify`/`rerank` have no `issueId` in general (a
 * direct tool/route call, not an issue-triggered event) and nothing to post
 * a confirmation card about — this log-only handler exists so an operator
 * who sets one of these policies to `suggest` by mistake gets a clear log
 * line instead of falling through to `jev.suggest.missing-handler`. */
async function suggestObserveOnly(input: SuggestInput, deps: SuggestDeps): Promise<void> {
  deps.log(`jev.suggest.${input.policy}.no-op`, { reason: "observe-only-policy" });
}

/** Bundles every field `comment-triage`/`run-outcome-qa` answered into one
 * `request_confirmation`, mirroring `suggestIssueTriage` — neither policy has
 * a native field to patch, so this is the only way a reviewer ever sees the
 * breakdown outside the ledger while the policy is in `suggest` mode. */
async function suggestFieldBundle(
  input: SuggestInput,
  deps: SuggestDeps,
  prompt: string,
  idempotencyPrefix: string,
): Promise<void> {
  const issueId = input.ctx.issueId;
  const fields = input.verdict.fields ?? [];
  if (!issueId || !deps.requestConfirmation || fields.length === 0) {
    deps.log(`jev.suggest.${idempotencyPrefix}.no-op`, {
      reason: !issueId ? "no-issue-id" : !deps.requestConfirmation ? "no-request-confirmation-dep" : "no-fields",
    });
    return;
  }

  const actionable = fields.filter((f) => f.action === "apply" || f.action === "suggest");
  const observedOnly = fields.filter((f) => f.action === "observe");
  const detailsMarkdown = [
    actionable.length > 0 ? "### Proposed changes" : "",
    ...actionable.map(describeField),
    observedOnly.length > 0 ? "### For your information" : "",
    ...observedOnly.map(describeField),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  await deps.requestConfirmation({
    issueId,
    companyId: input.ctx.companyId,
    prompt,
    detailsMarkdown,
    idempotencyKey: `jev:${idempotencyPrefix}:${issueId}:${input.ctx.stateHash ?? "unknown"}`,
  });
  deps.log(`jev.suggest.${idempotencyPrefix}`, { issueId, fieldCount: fields.length });
}

async function suggestCommentTriage(input: SuggestInput, deps: SuggestDeps): Promise<void> {
  await suggestFieldBundle(input, deps, "Jev triaged this comment. Apply the proposed actions?", "comment-triage");
}

async function suggestRunOutcomeQa(input: SuggestInput, deps: SuggestDeps): Promise<void> {
  await suggestFieldBundle(input, deps, "Jev reviewed this run's outcome. Post the reviewer comment?", "run-outcome-qa");
}

export const suggestHandlers: Record<string, SuggestFn> = {
  ping: suggestPing,
  "issue-triage": suggestIssueTriage,
  ask: suggestObserveOnly,
  "classify-task": suggestObserveOnly,
  verify: suggestObserveOnly,
  rerank: suggestObserveOnly,
  "comment-triage": suggestCommentTriage,
  "run-outcome-qa": suggestRunOutcomeQa,
};

export async function postSuggestion(input: SuggestInput, deps: SuggestDeps): Promise<void> {
  const handler = suggestHandlers[input.policy];
  if (!handler) {
    deps.log("jev.suggest.missing-handler", { policy: input.policy });
    return;
  }
  await handler(input, deps);
}
