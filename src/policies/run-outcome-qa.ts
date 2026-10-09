import { noul, type Questions } from "@typesafe-ai/sdk";
import { confidenceMarginFor } from "./issue-triage.js";
import type { FieldDecision, Policy, PolicyVerdict } from "./types.js";

export type RunOutcomeQaRunStatus = "succeeded" | "failed" | "timed_out";

export interface RunOutcomeQaState {
  issueId: string;
  runId: string;
  runStatus: RunOutcomeQaRunStatus;
  /** The last comment this run itself posted on the issue (matched by
   * `createdByRunId`), or `null` when the run left no comment at all —
   * itself a signal `decide()` can act on, not an error state. */
  finalCommentBody: string | null;
  issueTitle: string;
  issueDescription: string | null;
  /** `true` when this issue's `originKind` belongs to this plugin itself —
   * `preFilter` skips these unconditionally, matching `issue-triage`. */
  isPluginOrigin: boolean;
}

const NOUL_FIELDS = [
  "completion_claim_present",
  "claim_supported_by_evidence",
  "tests_mentioned",
  "scope_narrowed",
  "needs_review",
] as const;

export const runOutcomeQaPolicy: Policy<RunOutcomeQaState> = {
  name: "run-outcome-qa",
  version: "1.0.0",
  questionVersion: "1.0.0",
  defaultMode: "shadow",

  preFilter(state, ctx): boolean {
    if (state.isPluginOrigin) return false;
    // Each run's id/final-comment makes its state hash effectively unique,
    // so this rarely fires in practice — it exists for the same reason
    // `issue-triage` has it: a redelivered or re-run event for a run already
    // reviewed under identical state is a no-op, not a retry.
    if (ctx.stateHash && ctx.priorStateHash && ctx.stateHash === ctx.priorStateHash) return false;
    return true;
  },

  questions(): Questions {
    // Question text is static and never interpolates the comment body or
    // issue title/description — that text only reaches the provider through
    // `state`, which goes through the redaction/truncation pipeline first.
    return {
      completion_claim_present: noul(
        "Does the final comment claim the issue/task is done, complete, resolved, or ready for review?",
      ),
      claim_supported_by_evidence: noul(
        "If the final comment claims completion, is that claim backed by concrete evidence — specific changes " +
          "made, files touched, commands run, or test results — rather than just an assertion?",
      ),
      tests_mentioned: noul("Does the final comment mention running or passing tests to verify the change?"),
      scope_narrowed: noul(
        "Does the final comment describe doing meaningfully less than the issue originally asked for, without " +
          "explicitly flagging the reduced scope?",
      ),
      needs_review: noul(
        "Independent of what the final comment claims, does this run's outcome need a human or reviewer to " +
          "double-check it before being trusted?",
      ),
    };
  },

  decide(answers, ctx): PolicyVerdict {
    const confidenceMin = ctx.config.thresholds.confidenceMin ?? 0.7;
    const marginMin = ctx.config.thresholds.marginMin ?? 0.15;
    const clears = (cm: { confidence: number; margin: number } | null): boolean =>
      cm !== null && cm.confidence >= confidenceMin && cm.margin >= marginMin;

    const fields: FieldDecision[] = [];
    const nouls: Record<string, { value: boolean; confident: boolean }> = {};

    for (const key of NOUL_FIELDS) {
      const answer = answers[key];
      const cm = confidenceMarginFor(answer);
      if (answer?.type !== "noul" || !cm) continue;
      const value = answer.noul >= 0.5;
      nouls[key] = { value, confident: clears(cm) };
      fields.push({
        field: key,
        value,
        confidence: cm.confidence,
        margin: cm.margin,
        action: "observe",
        reason: "no-applicable-field",
      });
    }

    const completion = nouls.completion_claim_present;
    const evidence = nouls.claim_supported_by_evidence;
    const needsReview = nouls.needs_review;

    const unsupportedClaim = Boolean(
      completion?.value && completion.confident && evidence?.confident && !evidence.value,
    );
    const flaggedNeedsReview = Boolean(needsReview?.value && needsReview.confident);
    const flagged = unsupportedClaim || flaggedNeedsReview;

    fields.push({
      field: "reviewerComment",
      value: flagged,
      confidence: Math.max(
        confidenceMarginFor(answers.needs_review)?.confidence ?? 0,
        confidenceMarginFor(answers.completion_claim_present)?.confidence ?? 0,
      ),
      margin: Math.max(
        confidenceMarginFor(answers.needs_review)?.margin ?? 0,
        confidenceMarginFor(answers.completion_claim_present)?.margin ?? 0,
      ),
      // No native `Issue` field carries any of this — the only possible side
      // effect is posting a reviewer-facing comment, never a status/priority
      // change (that stays a human call).
      action: flagged ? "apply" : "observe",
      reason: flagged ? undefined : "below-threshold",
    });

    const verdict =
      unsupportedClaim && flaggedNeedsReview
        ? "flag:unsupported-claim+needs-review"
        : unsupportedClaim
          ? "flag:unsupported-claim"
          : flaggedNeedsReview
            ? "flag:needs-review"
            : "ok";

    const topCm = confidenceMarginFor(answers.needs_review) ?? confidenceMarginFor(answers.completion_claim_present);

    return {
      verdict,
      confidence: topCm?.confidence ?? null,
      margin: topCm?.margin ?? null,
      reason: "ok",
      fields,
    };
  },
};
