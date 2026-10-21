import type { CommentTriageState } from "../policies/comment-triage.js";
import type { FieldDecision, PolicyContext, PolicyVerdict } from "../policies/types.js";

export interface ApplyInput {
  policy: string;
  verdict: PolicyVerdict;
  ctx: PolicyContext;
  /** The same state value `decide()` saw, so a handler can read fields that
   * aren't part of `PolicyVerdict` itself (e.g. the issue's current label
   * ids, needed to merge rather than replace). Untyped here since handlers
   * are keyed by policy name, not generic over `TState`. */
  state?: unknown;
}

export interface ApplyDeps {
  /** Injected so side effects (e.g. issue mutations) go through `ctx`-scoped
   * host APIs rather than any ambient client — kept intentionally minimal
   * until a policy actually needs to act. */
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** Patches real `Issue` fields. Never called with `assigneeUserId` — that
   * rule has no override, enforced by the caller (`applyIssueTriage`), not
   * by this signature. */
  updateIssue?: (input: { issueId: string; companyId: string; patch: Record<string, unknown> }) => Promise<void>;
  /** Wakes the issue's current assignee. Never chooses or changes who the
   * assignee is — that stays `assigneeUserId`/`assigneeAgentId`'s business. */
  requestWakeup?: (input: {
    issueId: string;
    companyId: string;
    reason: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  /** Posts a plugin-authored comment. Only ever used for structured,
   * synthesized text describing a policy's own fields/flags — never raw
   * issue or comment content, which stays on the data side of the
   * redaction/truncation pipeline, not echoed back into the thread. */
  createComment?: (input: { issueId: string; companyId: string; body: string }) => Promise<void>;
}

export type ApplyFn = (input: ApplyInput, deps: ApplyDeps) => Promise<void>;

/**
 * All side effects of an `enforce`-mode decision live here, never in
 * `src/policies/`. The `ping` reference policy has nothing to apply — Jev
 * must never touch assignee/priority/status on its own, and no real policy
 * ships in `enforce` mode until its eval report clears the bar.
 */
async function applyPing(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  deps.log("jev.apply.ping", { verdict: input.verdict.verdict, issueId: input.ctx.issueId ?? null });
}

/** Builds the `issues.update` patch from only the fields `decide()` marked
 * `"apply"` — `assigneeAgentId` and `priority` have native columns;
 * `issueType` lands as an additive label id. Never includes `assigneeUserId`:
 * that field never appears in `FieldDecision.field` for this policy at all.
 *
 * `existingLabelIds` must be the issue's *current* label ids: the host's
 * `issues.update` replaces the full label set wholesale (it doesn't add),
 * so `labelIds` here always merges onto the existing set rather than
 * replacing it — otherwise applying an `issueType` label would silently
 * wipe out every other label a human (or another plugin) had set. */
function patchFor(
  fields: FieldDecision[],
  existingLabelIds: readonly string[],
  issueTypeLabelId: (issueType: string) => string | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.action !== "apply") continue;
    if (field.field === "assigneeAgentId") {
      patch.assigneeAgentId = field.value;
    } else if (field.field === "priority") {
      patch.priority = field.value;
    } else if (field.field === "issueType") {
      const labelId = issueTypeLabelId(String(field.value));
      if (labelId) patch.labelIds = [...new Set([...existingLabelIds, labelId])];
    }
  }
  return patch;
}

async function applyIssueTriage(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  const issueId = input.ctx.issueId;
  if (!issueId || !deps.updateIssue) {
    deps.log("jev.apply.issue-triage.no-op", { reason: !issueId ? "no-issue-id" : "no-update-issue-dep" });
    return;
  }
  const fields = input.verdict.fields ?? [];
  const options = (input.ctx.config.options as { issueTypeLabelIds?: Record<string, string> } | undefined) ?? {};
  const existingLabelIds = (input.state as { existingLabelIds?: string[] } | undefined)?.existingLabelIds ?? [];
  const patch = patchFor(fields, existingLabelIds, (issueType) => options.issueTypeLabelIds?.[issueType]);
  if (Object.keys(patch).length === 0) {
    deps.log("jev.apply.issue-triage.nothing-to-apply", { issueId });
    return;
  }
  await deps.updateIssue({ issueId, companyId: input.ctx.companyId, patch });
  deps.log("jev.apply.issue-triage", { issueId, patch: Object.keys(patch) });
}

/** `ask`/`classify-task`/`verify`/`rerank` never mark a field `"apply"` —
 * these log-only handlers exist so an operator who sets one of these
 * policies to `enforce` by mistake gets a clear log line instead of falling
 * through to `jev.apply.missing-handler`. */
async function applyObserveOnly(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  deps.log(`jev.apply.${input.policy}.no-op`, { reason: "observe-only-policy" });
}

/**
 * The guard policies' only side effect is the `allow`/`ask`/`deny` decision
 * already returned synchronously to the calling hook by `evaluateGuard` —
 * there is nothing further to apply here even in `enforce` mode. These
 * handlers exist so `applyDecision` doesn't log a missing-handler warning
 * if a guard policy's ledger row is ever replayed through this path.
 */
async function applyGuard(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  deps.log("jev.apply.guard", { policy: input.policy, verdict: input.verdict.verdict, runId: input.ctx.runId ?? null });
}

/** Wakes the assignee when `decide()` marked `wakeupAssignee` as `"apply"` —
 * the only possible side effect `comment-triage` has, and only ever a wakeup,
 * never a reassignment or status change. */
async function applyCommentTriage(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  const issueId = input.ctx.issueId;
  const wakeupField = (input.verdict.fields ?? []).find((f) => f.field === "wakeupAssignee");
  if (!issueId || !deps.requestWakeup || !wakeupField || wakeupField.action !== "apply") {
    deps.log("jev.apply.comment-triage.no-op", {
      reason: !issueId
        ? "no-issue-id"
        : !deps.requestWakeup
          ? "no-request-wakeup-dep"
          : !wakeupField || wakeupField.action !== "apply"
            ? "nothing-to-apply"
            : "unknown",
    });
    return;
  }
  const commentId = (input.state as CommentTriageState | undefined)?.commentId;
  await deps.requestWakeup({
    issueId,
    companyId: input.ctx.companyId,
    reason: `jev.comment-triage.${input.verdict.verdict}`,
    idempotencyKey: commentId ? `jev:comment-triage:${commentId}` : undefined,
  });
  deps.log("jev.apply.comment-triage", { issueId, verdict: input.verdict.verdict });
}

/** Posts a reviewer-facing comment when `decide()` flagged the run's
 * completion claim or outcome as needing review — never changes the issue's
 * status, priority, or assignee. The comment body only ever references
 * structured flags, never the agent's raw final-comment text. */
async function applyRunOutcomeQa(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  const issueId = input.ctx.issueId;
  const commentField = (input.verdict.fields ?? []).find((f) => f.field === "reviewerComment");
  if (!issueId || !deps.createComment || !commentField || commentField.action !== "apply") {
    deps.log("jev.apply.run-outcome-qa.no-op", {
      reason: !issueId
        ? "no-issue-id"
        : !deps.createComment
          ? "no-create-comment-dep"
          : !commentField || commentField.action !== "apply"
            ? "nothing-to-apply"
            : "unknown",
    });
    return;
  }
  const lines = [
    "Jev flagged this run's outcome for review.",
    `- verdict: \`${input.verdict.verdict}\``,
    ...(input.verdict.fields ?? [])
      .filter((f) => f.field !== "reviewerComment")
      .map((f) => `- ${f.field}: \`${JSON.stringify(f.value)}\``),
  ];
  await deps.createComment({ issueId, companyId: input.ctx.companyId, body: lines.join("\n") });
  deps.log("jev.apply.run-outcome-qa", { issueId, verdict: input.verdict.verdict });
}

/**
 * `browser-action` has nothing to apply here either: the tool is advisory by
 * construction — the harness, never this plugin, drives the browser. This
 * only logs the recommended action for observability.
 */
async function applyBrowserAction(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  deps.log("jev.apply.browser-action", { verdict: input.verdict.verdict, issueId: input.ctx.issueId ?? null });
}

export const applyHandlers: Record<string, ApplyFn> = {
  ping: applyPing,
  "issue-triage": applyIssueTriage,
  ask: applyObserveOnly,
  "classify-task": applyObserveOnly,
  verify: applyObserveOnly,
  rerank: applyObserveOnly,
  "guard-pre": applyGuard,
  "guard-post": applyGuard,
  "guard-stop": applyGuard,
  "comment-triage": applyCommentTriage,
  "run-outcome-qa": applyRunOutcomeQa,
  "browser-action": applyBrowserAction,
};

export async function applyDecision(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  const handler = applyHandlers[input.policy];
  if (!handler) {
    deps.log("jev.apply.missing-handler", { policy: input.policy });
    return;
  }
  await handler(input, deps);
}
