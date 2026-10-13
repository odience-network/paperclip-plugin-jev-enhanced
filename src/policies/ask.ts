import type { Questions } from "@typesafe-ai/sdk";
import type { FieldDecision, Policy, PolicyVerdict } from "./types.js";
import { confidenceMarginFor } from "./util.js";

/**
 * Generic ask: the caller supplies both `state` and `questions` directly
 * (validated by `src/tools/schemas.ts` against the same `jevQuestionSchema`
 * the core connector uses, before this policy ever sees them) — this policy
 * exists only to run that pair through the standard ledger/budget pipeline,
 * never to interpret the answers itself. Every field is `"observe"`: a
 * generic question has no native Issue field to patch, and the caller is the
 * one deciding what the answers mean.
 */
export interface AskState {
  state: unknown;
  questions: Questions;
}

export const askPolicy: Policy<AskState> = {
  name: "ask",
  version: "1.0.0",
  questionVersion: "1.0.0",
  defaultMode: "shadow",

  identityState(state) {
    return state.state;
  },

  preFilter(state): boolean {
    return Object.keys(state.questions).length > 0;
  },

  questions(state): Questions {
    return state.questions;
  },

  decide(answers): PolicyVerdict {
    const fields: FieldDecision[] = [];
    let minConfidence: number | null = null;
    let minMargin: number | null = null;

    for (const [key, answer] of Object.entries(answers)) {
      const cm = confidenceMarginFor(answer);
      const value = answer.type === "noul" ? answer.noul >= 0.5 : answer.type === "choice" ? answer.choice : answer.score;
      fields.push({
        field: key,
        value,
        confidence: cm?.confidence ?? 0,
        margin: cm?.margin ?? 0,
        action: "observe",
        reason: "no-applicable-field",
      });
      if (cm) {
        minConfidence = minConfidence === null ? cm.confidence : Math.min(minConfidence, cm.confidence);
        minMargin = minMargin === null ? cm.margin : Math.min(minMargin, cm.margin);
      }
    }

    return {
      verdict: fields.length > 0 ? "answered" : "no-answer",
      confidence: minConfidence,
      margin: minMargin,
      reason: fields.length > 0 ? "ok" : "missing-or-invalid-answer",
      fields,
    };
  },
};
