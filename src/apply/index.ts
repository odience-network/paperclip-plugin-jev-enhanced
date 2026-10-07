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

export const applyHandlers: Record<string, ApplyFn> = {
  ping: applyPing,
  "issue-triage": applyIssueTriage,
};

export async function applyDecision(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  const handler = applyHandlers[input.policy];
  if (!handler) {
    deps.log("jev.apply.missing-handler", { policy: input.policy });
    return;
  }
  await handler(input, deps);
}
