import { choice, type Questions } from "@typesafe-ai/sdk";
import type { FieldDecision, Policy, PolicyVerdict } from "./types.js";
import { confidenceMarginFor } from "./util.js";

export const VERIFY_RELATION_CATALOG = ["supports", "contradicts", "says_nothing"] as const;

export interface VerifyState {
  /** A single atomic claim, e.g. "this issue is done" or "the fix handles
   * the empty-input case". */
  claim: string;
  /** The evidence to check the claim against — e.g. test output, a diff, or
   * a log excerpt. Jev is not injection-aware: `evidence` from an untrusted
   * source (like a PR description) must already have passed through this
   * plugin's redaction pipeline before `verify` is called. */
  evidence: string;
}

/**
 * Checks whether `evidence` supports, contradicts, or says nothing about
 * `claim` — the completion-claim-vs-test-evidence case from the issue is
 * just this with `claim` phrased as "this task is done" and `evidence` set
 * to the actual test run output, not a restatement of the claim. No native
 * `Issue` field carries this verdict; it is only ever returned to the caller.
 */
export const verifyPolicy: Policy<VerifyState> = {
  name: "verify",
  version: "1.0.0",
  questionVersion: "1.0.0",
  defaultMode: "shadow",

  preFilter(state): boolean {
    return (
      typeof state.claim === "string" &&
      state.claim.trim().length > 0 &&
      typeof state.evidence === "string" &&
      state.evidence.trim().length > 0
    );
  },

  questions(): Questions {
    return {
      relation: choice(
        'Given the "claim" and "evidence" in state, does the evidence support the claim, contradict it, or say ' +
          "nothing relevant to it? A completion claim (e.g. \"this is done\") is only supported by evidence that " +
          "a test or check actually passed — not by the claim restated in different words.",
        { supports: null, contradicts: null, says_nothing: null },
      ),
    };
  },

  decide(answers): PolicyVerdict {
    const answer = answers.relation;
    const cm = confidenceMarginFor(answer);
    if (answer?.type !== "choice" || !cm) {
      return { verdict: "no-answer", confidence: null, margin: null, reason: "missing-or-invalid-answer" };
    }
    const fields: FieldDecision[] = [
      {
        field: "relation",
        value: answer.choice,
        confidence: cm.confidence,
        margin: cm.margin,
        action: "observe",
        reason: "no-applicable-field",
      },
    ];
    return { verdict: answer.choice, confidence: cm.confidence, margin: cm.margin, reason: "ok", fields };
  },
};
