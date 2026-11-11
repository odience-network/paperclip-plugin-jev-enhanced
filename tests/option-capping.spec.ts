import { describe, expect, it, vi } from "vitest";
import { capRankedChoices, DecisionPipeline } from "../src/decision/pipeline.js";
import type { DecisionProvider, DecisionRequest } from "../src/decision/provider.js";
import { issueTriagePolicy, type IssueTriageState } from "../src/policies/issue-triage.js";
import type { DecisionQuestions } from "../src/decision/types.js";

const options = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`o${i}`, `option ${i}`]));

describe("capRankedChoices", () => {
  const questions: DecisionQuestions = {
    owner: { type: "choice", instructions: "who", criteria: { ...options(5), none: "nobody" } },
    other: { type: "choice", instructions: "what", criteria: options(5) },
  };

  it("keeps pinned options plus the best-ranked rest, in the question's own order", () => {
    const capped = capRankedChoices(questions, { owner: { ranked: ["o3", "o1", "o0"], pinned: ["none"] } }, 3);
    expect(Object.keys((capped.owner as { criteria: object }).criteria)).toEqual(["o1", "o3", "none"]);
    // Unranked questions are never trimmed; the pre-check skips them instead.
    expect(capped.other).toBe(questions.other);
  });

  it("fills from the question's order when the ranking is shorter than the cap", () => {
    const capped = capRankedChoices(questions, { owner: { ranked: ["o4"], pinned: ["none"] } }, 4);
    expect(Object.keys((capped.owner as { criteria: object }).criteria)).toEqual(["o0", "o1", "o4", "none"]);
  });

  it("returns the same object when nothing exceeds the cap", () => {
    expect(capRankedChoices(questions, { owner: { ranked: [], pinned: [] } }, 10)).toBe(questions);
  });
});

describe("pipeline: per-provider option capping", () => {
  function provider(id: string, maxChoiceOptions: number) {
    const decide = vi.fn(async (req: DecisionRequest) => {
      const owner = req.questions.owner as { criteria: Record<string, unknown> };
      const labels = Object.keys(owner.criteria);
      return {
        model: `${id}-model`,
        answers: {
          owner: {
            type: "choice" as const,
            choice: labels[0],
            probabilities: Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 1 : 0])),
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      };
    });
    const p: DecisionProvider = {
      id,
      kind: "systemone",
      model: `${id}-model`,
      verification: "fixtures",
      capabilities: {
        questionTypes: ["boolean", "choice", "score"],
        maxQuestions: 64,
        maxChoiceOptions,
        maxScoreLevels: 10,
        maxRequestBytes: 1_000_000,
        images: false,
        confidence: "native",
        probabilities: true,
        billing: "plugin",
      },
      availability: async () => ({ ok: true }),
      decide,
    };
    return { provider: p, decide };
  }

  it("sends a capped question to a small provider instead of skipping it", async () => {
    const { provider: small, decide } = provider("small", 4);
    const outcome = await new DecisionPipeline({ providers: [small] }).ask({
      policy: "issue-triage",
      companyId: "c1",
      state: "s",
      questions: { owner: { type: "choice", instructions: "who", criteria: { ...options(30), unassigned: null } } },
      choiceRanking: { owner: { ranked: ["o29", "o7", "o3"], pinned: ["unassigned"] } },
    });

    const sent = decide.mock.calls[0][0].questions.owner as { criteria: Record<string, unknown> };
    expect(Object.keys(sent.criteria)).toEqual(["o3", "o7", "o29", "unassigned"]);
    expect(outcome.fallbackFrom).toBeNull();
  });

  it("still skips an oversized question that has no ranking", async () => {
    const { provider: small } = provider("small", 4);
    await expect(
      new DecisionPipeline({ providers: [small] }).ask({
        policy: "p",
        companyId: "c1",
        state: "s",
        questions: { owner: { type: "choice", instructions: "who", criteria: options(30) } },
      }),
    ).rejects.toMatchObject({ reason: "capability-max-options" });
  });
});

describe("issue-triage rankChoices", () => {
  const state = {
    title: "Stripe webhook retries fail",
    description: "Billing webhooks from Stripe return 500",
    eligibleAgents: [
      { id: "a-frontend", name: "Frontend Lead", role: "ui" },
      { id: "a-billing", name: "Billing Engineer", role: "payments stripe" },
      { id: "a-docs", name: "Docs Writer", role: "documentation" },
    ],
    recentOpenIssues: [
      { id: "i-new", identifier: "X-3", title: "Dark mode toggle" },
      { id: "i-dup", identifier: "X-2", title: "Stripe webhook 500 errors" },
    ],
  } as unknown as IssueTriageState;

  it("ranks owner and duplicateOf candidates by word overlap with the issue, keeping sentinels pinned", () => {
    const ranking = issueTriagePolicy.rankChoices!(state, {} as never);
    expect(ranking.owner).toEqual({ ranked: ["a-billing", "a-frontend", "a-docs"], pinned: ["unassigned", "needs_triage"] });
    expect(ranking.duplicateOf).toEqual({ ranked: ["i-dup", "i-new"], pinned: ["none"] });
  });
});
