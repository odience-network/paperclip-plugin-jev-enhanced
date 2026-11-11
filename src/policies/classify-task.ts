import { choice, noul, type Questions } from "@typesafe-ai/sdk";
import type { FieldDecision, Policy, PolicyVerdict } from "./types.js";
import { confidenceMarginFor } from "./util.js";

export const WORK_KIND_CATALOG = ["feature", "bug", "refactor", "chore", "docs", "research"] as const;
export const MODEL_TIER_CATALOG = ["fast", "standard", "strong"] as const;
export const REVIEW_DEPTH_CATALOG = ["light", "standard", "thorough"] as const;

export interface ClassifyTaskCandidateSkill {
  id: string;
  name: string;
}

export interface ClassifyTaskState {
  description: string;
  /** Skills the caller already knows exist (e.g. from the company's skill
   * library) and wants a per-skill load recommendation for. Empty is valid —
   * `workKind`/`modelTier`/`reviewDepth` never depend on this list. */
  candidateSkills: ClassifyTaskCandidateSkill[];
}

/**
 * Classifies a unit of work along three independent axes (kind, model tier,
 * review depth) and optionally recommends which of the caller's candidate
 * skills to load. No native `Issue` field carries any of these — every
 * field is `"observe"` and only ever returned to the caller, never applied.
 */
export const classifyTaskPolicy: Policy<ClassifyTaskState> = {
  name: "classify-task",
  version: "1.0.0",
  questionVersion: "1.0.0",
  defaultMode: "shadow",

  identityState(state) {
    return { description: state.description, candidateSkillIds: [...state.candidateSkills.map((skill) => skill.id)].sort() };
  },

  preFilter(state): boolean {
    return typeof state.description === "string" && state.description.trim().length > 0;
  },

  questions(state): Questions {
    const questions: Questions = {
      workKind: choice(
        "What kind of work does this task require? Use the task description given above as state to decide.",
        Object.fromEntries(WORK_KIND_CATALOG.map((kind) => [kind, null])),
      ),
      modelTier: choice(
        "What model tier does this task need? fast = routine/mechanical work, standard = typical engineering " +
          "work, strong = high-ambiguity or high-stakes work",
        Object.fromEntries(MODEL_TIER_CATALOG.map((tier) => [tier, null])),
      ),
      reviewDepth: choice(
        "How deep should review be before this task's output ships? light = low-risk and easily reversible, " +
          "standard = a typical change, thorough = high-risk or hard-to-reverse",
        Object.fromEntries(REVIEW_DEPTH_CATALOG.map((depth) => [depth, null])),
      ),
    };

    for (const skill of state.candidateSkills) {
      questions[`loadSkill:${skill.id}`] = noul(`Does completing this task require the "${skill.name}" skill?`);
    }

    return questions;
  },

  decide(answers): PolicyVerdict {
    const fields: FieldDecision[] = [];

    for (const key of ["workKind", "modelTier", "reviewDepth"] as const) {
      const answer = answers[key];
      const cm = confidenceMarginFor(answer);
      if (answer?.type === "choice" && cm) {
        fields.push({
          field: key,
          value: answer.choice,
          confidence: cm.confidence,
          margin: cm.margin,
          action: "observe",
          reason: "no-applicable-field",
        });
      }
    }

    for (const [key, answer] of Object.entries(answers)) {
      if (!key.startsWith("loadSkill:")) continue;
      const cm = confidenceMarginFor(answer);
      if (answer.type === "noul" && cm) {
        fields.push({
          field: key,
          value: answer.noul >= 0.5,
          confidence: cm.confidence,
          margin: cm.margin,
          action: "observe",
          reason: "no-applicable-field",
        });
      }
    }

    const workKindField = fields.find((f) => f.field === "workKind");
    if (!workKindField) {
      return { verdict: "no-answer", confidence: null, margin: null, reason: "missing-or-invalid-answer", fields };
    }

    return {
      verdict: `work-kind:${workKindField.value}`,
      confidence: workKindField.confidence,
      margin: workKindField.margin,
      reason: "ok",
      fields,
    };
  },
};
