import { describe, expect, it } from "vitest";
import type { PolicyContext } from "../src/policies/types.js";
import { askPolicy } from "../src/policies/ask.js";
import {
  classifyTaskPolicy,
  WORK_KIND_CATALOG,
  MODEL_TIER_CATALOG,
  REVIEW_DEPTH_CATALOG,
} from "../src/policies/classify-task.js";
import { verifyPolicy, VERIFY_RELATION_CATALOG } from "../src/policies/verify.js";
import { rerankPolicy } from "../src/policies/rerank.js";

function baseCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    companyId: "company_1",
    issueId: null,
    runId: null,
    agentId: null,
    config: { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} },
    respectExistingFields: true,
    alwaysAuto: false,
    stateHash: "hash",
    priorStateHash: null,
    ...overrides,
  };
}

function choiceAnswer(choiceValue: string, options: readonly string[], confidence = 0.9) {
  const rest = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
  const probabilities = Object.fromEntries(options.map((option) => [option, option === choiceValue ? confidence : rest]));
  return { type: "choice" as const, choice: choiceValue, confidence, probabilities };
}

function noulAnswer(value: number) {
  return { type: "noul" as const, noul: value };
}

describe("askPolicy", () => {
  it("pre-filters out an empty questions map", () => {
    expect(askPolicy.preFilter({ state: "hello", questions: {} }, baseCtx())).toBe(false);
  });

  it("does not pre-filter when at least one question is present", () => {
    const state = { state: "hello", questions: { isBug: { type: "noul" as const, instructions: "is this a bug?" } } };
    expect(askPolicy.preFilter(state, baseCtx())).toBe(true);
  });

  it("marks every field observe-only and reports the minimum confidence/margin across answers", () => {
    const verdict = askPolicy.decide({ isBug: noulAnswer(0.9), isUrgent: noulAnswer(0.6) }, baseCtx());
    expect(verdict.verdict).toBe("answered");
    expect(verdict.fields).toHaveLength(2);
    expect(verdict.fields?.every((field) => field.action === "observe")).toBe(true);
    // noul(0.6) has a lower confidence (max(0.6, 0.4) = 0.6) than noul(0.9) (0.9).
    expect(verdict.confidence).toBe(0.6);
  });

  it("returns no-answer when there are no answers at all", () => {
    const verdict = askPolicy.decide({}, baseCtx());
    expect(verdict.verdict).toBe("no-answer");
    expect(verdict.fields).toHaveLength(0);
  });
});

describe("classifyTaskPolicy", () => {
  it("pre-filters out a blank description", () => {
    expect(classifyTaskPolicy.preFilter({ description: "   ", candidateSkills: [] }, baseCtx())).toBe(false);
    expect(classifyTaskPolicy.preFilter({ description: "fix the bug", candidateSkills: [] }, baseCtx())).toBe(true);
  });

  it("asks one choice question per axis plus one noul per candidate skill", () => {
    const questions = classifyTaskPolicy.questions(
      { description: "fix the bug", candidateSkills: [{ id: "skill_1", name: "Auth" }] },
      baseCtx(),
    );
    expect(Object.keys(questions)).toEqual(
      expect.arrayContaining(["workKind", "modelTier", "reviewDepth", "loadSkill:skill_1"]),
    );
  });

  it("decides work-kind:<value> and marks every field observe-only, including per-skill recommendations", () => {
    const answers = {
      workKind: choiceAnswer("bug", WORK_KIND_CATALOG),
      modelTier: choiceAnswer("standard", MODEL_TIER_CATALOG),
      reviewDepth: choiceAnswer("standard", REVIEW_DEPTH_CATALOG),
      "loadSkill:skill_1": noulAnswer(0.8),
    };
    const verdict = classifyTaskPolicy.decide(answers, baseCtx());
    expect(verdict.verdict).toBe("work-kind:bug");
    expect(verdict.fields?.every((field) => field.action === "observe")).toBe(true);
    expect(verdict.fields?.find((field) => field.field === "loadSkill:skill_1")?.value).toBe(true);
  });

  it("returns no-answer when the workKind answer is missing", () => {
    const verdict = classifyTaskPolicy.decide(
      { modelTier: choiceAnswer("standard", MODEL_TIER_CATALOG) },
      baseCtx(),
    );
    expect(verdict.verdict).toBe("no-answer");
  });
});

describe("verifyPolicy", () => {
  it("pre-filters out a missing claim or evidence", () => {
    expect(verifyPolicy.preFilter({ claim: "", evidence: "test output" }, baseCtx())).toBe(false);
    expect(verifyPolicy.preFilter({ claim: "this is done", evidence: "" }, baseCtx())).toBe(false);
    expect(verifyPolicy.preFilter({ claim: "this is done", evidence: "42 passed" }, baseCtx())).toBe(true);
  });

  it("decides the verdict as the relation choice itself", () => {
    const verdict = verifyPolicy.decide({ relation: choiceAnswer("supports", VERIFY_RELATION_CATALOG) }, baseCtx());
    expect(verdict.verdict).toBe("supports");
    expect(verdict.fields).toHaveLength(1);
    expect(verdict.fields?.[0]?.action).toBe("observe");
  });

  it("returns no-answer when the relation answer is missing or the wrong type", () => {
    expect(verifyPolicy.decide({}, baseCtx()).verdict).toBe("no-answer");
    expect(verifyPolicy.decide({ relation: noulAnswer(0.9) }, baseCtx()).verdict).toBe("no-answer");
  });
});

describe("rerankPolicy", () => {
  it("pre-filters out an empty query or an empty candidate list", () => {
    expect(rerankPolicy.preFilter({ query: "", candidates: [{ id: "c1", text: "x" }] }, baseCtx())).toBe(false);
    expect(rerankPolicy.preFilter({ query: "q", candidates: [] }, baseCtx())).toBe(false);
    expect(rerankPolicy.preFilter({ query: "q", candidates: [{ id: "c1", text: "x" }] }, baseCtx())).toBe(true);
  });

  it("asks three noul questions per candidate", () => {
    const questions = rerankPolicy.questions({ query: "q", candidates: [{ id: "c1", text: "x" }] }, baseCtx());
    expect(Object.keys(questions).sort()).toEqual(["containsAnswer:c1", "injection:c1", "relevant:c1"]);
  });

  it("decides ranked and marks every per-candidate field observe-only", () => {
    const state = { query: "q", candidates: [{ id: "c1", text: "x" }] };
    const answers = {
      "relevant:c1": noulAnswer(0.9),
      "containsAnswer:c1": noulAnswer(0.85),
      "injection:c1": noulAnswer(0.05),
    };
    const verdict = rerankPolicy.decide(answers, baseCtx(), state);
    expect(verdict.verdict).toBe("ranked");
    expect(verdict.fields).toHaveLength(3);
    expect(verdict.fields?.every((field) => field.action === "observe")).toBe(true);
    expect(verdict.fields?.find((field) => field.field === "injection:c1")?.value).toBe(false);
  });

  it("returns no-answer when no candidate has any valid answer", () => {
    const state = { query: "q", candidates: [{ id: "c1", text: "x" }] };
    expect(rerankPolicy.decide({}, baseCtx(), state).verdict).toBe("no-answer");
  });
});
