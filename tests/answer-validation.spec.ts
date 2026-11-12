import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "@typesafe-ai/sdk";
import { DecisionPipeline, type ChoiceRanking } from "../src/decision/pipeline.js";
import type { DecisionProvider } from "../src/decision/provider.js";
import { classifyError, errorClassOf } from "../src/decision/errors.js";
import { CloudflareProvider } from "../src/decision/providers/cloudflare.js";
import { OpenAiProvider } from "../src/decision/providers/openai.js";
import { SYSTEMONE_PRESETS } from "../src/decision/providers/presets.js";
import { SystemOneProvider } from "../src/decision/providers/systemone.js";
import type { DecisionAnswer, DecisionQuestions } from "../src/decision/types.js";

/**
 * ODIAA-2473 F1/F2: provider output is checked against the questions actually
 * sent, and question text goes through `redactionPatterns`, for every
 * provider kind. Each provider is driven by a fetch that replies with
 * hand-written SystemOne-shaped answers in that provider's wire shape.
 */

type Answers = Record<string, DecisionAnswer>;

interface SentRequest {
  url: string;
  body: string;
}

interface ProviderKindCase {
  name: string;
  build: (fetchImpl: Fetch) => DecisionProvider;
  /** Wraps SystemOne-shaped answers in the provider's reply body. */
  reply: (model: string, answers: Answers) => unknown;
}

function toOpenAiAnswer(name: string, answer: DecisionAnswer): unknown {
  switch (answer.type) {
    case "noul":
      return { type: "predicate", name, probability: answer.noul };
    case "choice":
      return {
        type: "choice",
        name,
        choice: answer.choice,
        probabilities: Object.entries(answer.probabilities).map(([value, probability]) => ({ value, probability })),
        confidence: answer.confidence,
      };
    case "score":
      return {
        type: "score",
        name,
        score: answer.score,
        probabilities: Object.entries(answer.probabilities).map(([value, probability]) => ({ value: Number(value), probability })),
        confidence: answer.confidence,
      };
  }
}

const usage = { input_tokens: 100, output_tokens: 0 };

const KINDS: ProviderKindCase[] = [
  {
    name: "systemone (typesafe preset)",
    build: (fetchImpl) =>
      new SystemOneProvider({ id: "typesafe", preset: SYSTEMONE_PRESETS.typesafe, resolveApiKey: async () => "k", fetchImpl, retry: { maxRetries: 0 } }),
    reply: (model, answers) => ({ model, answers, usage }),
  },
  {
    name: "cloudflare (clef-flash)",
    build: (fetchImpl) =>
      new CloudflareProvider({ id: "cloudflare", accountId: "0123456789abcdef0123456789abcdef", resolveApiKey: async () => "k", fetchImpl, retry: { maxRetries: 0 } }),
    reply: (model, answers) => ({ success: true, result: { model, answers, usage }, errors: [], messages: [] }),
  },
  {
    name: "openai (gpt-6-luna)",
    build: (fetchImpl) => new OpenAiProvider({ id: "openai", resolveApiKey: async () => "k", fetchImpl, retry: { maxRetries: 0 } }),
    reply: (model, answers) => ({ model, answers: Object.entries(answers).map(([name, answer]) => toOpenAiAnswer(name, answer)), usage }),
  },
];

/** A provider whose fetch answers every decide call with `answers`, and a
 * log of what it was sent. `maxChoiceOptions` narrows its caps so ranked
 * choices get capped. */
function replying(kind: ProviderKindCase, answers: Answers, maxChoiceOptions?: number) {
  const sent: SentRequest[] = [];
  let provider: DecisionProvider | undefined;
  const fetchImpl = vi.fn<Fetch>(async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    sent.push({ url: String(input), body });
    return new Response(JSON.stringify(kind.reply(provider!.model, answers)), { status: 200, headers: { "content-type": "application/json" } });
  });
  provider = kind.build(fetchImpl);
  if (maxChoiceOptions !== undefined) {
    Object.defineProperty(provider, "capabilities", { value: { ...provider.capabilities, maxChoiceOptions } });
  }
  return { provider, sent };
}

const QUESTIONS: DecisionQuestions = {
  owner: { type: "choice", instructions: "Who owns this?", criteria: { agent_a: "Ada", agent_b: "Bo", unassigned: null } },
  urgent: { type: "boolean", instructions: "Is it urgent?" },
  size: { type: "score", instructions: "How big?", criteria: ["small", "medium", "large"] },
};

const choice = (option: string, rest: Record<string, number> = {}): DecisionAnswer => ({
  type: "choice",
  choice: option,
  probabilities: { [option]: 0.9, ...rest },
  confidence: 0.9,
});

const VALID: Answers = {
  owner: choice("agent_a", { agent_b: 0.05, unassigned: 0.05 }),
  urgent: { type: "noul", noul: 0.8 },
  size: { type: "score", score: 1, legend: { 0: "small", 1: "medium", 2: "large" }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 }, confidence: 0.8 },
};

async function ask(provider: DecisionProvider | DecisionProvider[], options: { ranking?: Record<string, ChoiceRanking>; questions?: DecisionQuestions; redactionPatterns?: string[] } = {}) {
  const pipeline = new DecisionPipeline({ providers: [provider].flat(), redactionPatterns: options.redactionPatterns });
  return pipeline.ask({ policy: "p", companyId: "c1", state: "s", questions: options.questions ?? QUESTIONS, choiceRanking: options.ranking });
}

async function failure(provider: DecisionProvider, options?: Parameters<typeof ask>[1]) {
  const error = await ask(provider, options).catch((e: unknown) => e);
  expect(classifyError(error)).toBe("validation-failed");
  expect(errorClassOf(error)).toBe("invalid_output");
  return error;
}

describe.each(KINDS)("answers are checked against the questions sent: $name", (kind) => {
  it("accepts answers that match the questions", async () => {
    const outcome = await ask(replying(kind, VALID).provider);
    expect(outcome.result.answers.owner).toMatchObject({ type: "choice", choice: "agent_a" });
  });

  it("rejects a choice that was never offered", async () => {
    await failure(replying(kind, { ...VALID, owner: choice("agent_NOT_ELIGIBLE", { agent_a: 0.1 }) }).provider);
  });

  it("rejects an answer for a question that was not asked", async () => {
    await failure(replying(kind, { ...VALID, rogue: { type: "noul", noul: 0.9 } }).provider);
  });

  it("rejects an answer whose type does not match its question", async () => {
    await failure(replying(kind, { ...VALID, urgent: choice("yes", { no: 0.1 }) }).provider);
  });

  it("rejects a score outside the question's levels", async () => {
    await failure(replying(kind, { ...VALID, size: { ...VALID.size, score: 7 } as DecisionAnswer }).provider);
  });

  it("rejects an option the pipeline capped away for this provider", async () => {
    const questions: DecisionQuestions = {
      ...QUESTIONS,
      owner: { type: "choice", instructions: "Who owns this?", criteria: { agent_a: "Ada", agent_b: "Bo", agent_c: "Cy", agent_d: "Di", unassigned: null } },
    };
    const ranking = { owner: { ranked: ["agent_a", "agent_b"], pinned: ["unassigned"] } };
    const { provider, sent } = replying(kind, { ...VALID, owner: choice("agent_d", { agent_a: 0.1 }) }, 3);
    await failure(provider, { questions, ranking });
    // agent_d was offered to the pipeline but not to this provider.
    expect(sent.at(-1)!.body).not.toContain("agent_d");
  });

  it("falls back to the next provider on output that fails the check", async () => {
    const bad = replying(kind, { ...VALID, owner: choice("agent_NOT_ELIGIBLE", { agent_a: 0.1 }) }).provider;
    const good = replying(KINDS[0], VALID).provider;
    const outcome = await ask([bad, good]);
    expect(outcome.provider).toBe(good);
    expect(outcome.fallbackFrom).toBe("invalid_output");
  });

  it("redacts question text, option keys and names before they are sent, and restores them on the answers", async () => {
    const questions: DecisionQuestions = {
      owner: {
        type: "choice",
        instructions: { note: "escalate to SECRET-INSTR-1" },
        criteria: { agent_a: "Ada, key SECRET-CRIT-2", "SECRET-KEY-3": "named after a secret" },
      },
      "SECRET-NAME-4": { type: "boolean", instructions: "plain?", criteria: { true: "SECRET-TRUE-5" } },
      size: { type: "score", instructions: "SECRET-SCORE-6 how big?", criteria: ["small", "SECRET-LEVEL-7"] },
    };
    // Answers as the provider sees the questions: redacted names and keys.
    const answers: Answers = {
      owner: choice("[REDACTED]", { agent_a: 0.1 }),
      "[REDACTED]": { type: "noul", noul: 0.7 },
      size: { type: "score", score: 0, legend: { 0: "small", 1: "[REDACTED]" }, probabilities: { 0: 0.9, 1: 0.1 }, confidence: 0.9 },
    };
    const { provider, sent } = replying(kind, answers);
    const outcome = await ask(provider, { questions, redactionPatterns: ["SECRET-[A-Z]+-\\d"] });

    const body = sent.at(-1)!.body;
    expect(body).not.toMatch(/SECRET-/);
    expect(body).toContain("[REDACTED]");
    expect(outcome.result.answers.owner).toMatchObject({ choice: "SECRET-KEY-3", probabilities: { "SECRET-KEY-3": 0.9, agent_a: 0.1 } });
    expect(outcome.result.answers["SECRET-NAME-4"]).toEqual({ type: "noul", noul: 0.7 });
  });
});
