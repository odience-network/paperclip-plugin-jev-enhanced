import { describe, expect, it } from "vitest";
import { DecisionPipeline } from "../../src/decision/pipeline.js";
import type { DecisionProvider } from "../../src/decision/provider.js";
import { classifyError } from "../../src/decision/errors.js";
import { CloudflareProvider, type CloudflareModel } from "../../src/decision/providers/cloudflare.js";
import { OpenAiProvider } from "../../src/decision/providers/openai.js";
import { SYSTEMONE_PRESETS } from "../../src/decision/providers/presets.js";
import { SystemOneProvider } from "../../src/decision/providers/systemone.js";
import type { DecisionQuestions } from "../../src/decision/types.js";

/**
 * L3 live smoke (plan 2.3b): ping, listModels, one boolean, one choice, one
 * score and one refusal per provider whose `VERDICT_LIVE_<PROVIDER>_TOKEN` is
 * set. A provider without a token is skipped, not failed.
 *
 * Output is safe to paste into a PR: assertions print only shapes and
 * classified error codes, never tokens or raw provider bodies.
 */

interface LiveTarget {
  name: string;
  tokenVar: string;
  /** Other env vars the target needs besides the token. */
  extraVars?: string[];
  build(token: string): DecisionProvider;
  /**
   * A request the provider must not answer. OpenAI has a refusal answer type
   * (a harmful question is refused); SystemOne-shaped providers have none,
   * so for them an unknown model's 4xx stands in.
   */
  refusal: { build(token: string): DecisionProvider; questions: DecisionQuestions; code: RegExp };
}

const NOT_ANSWERABLE = /^(provider-error-4\d\d|validation-failed)$/;
const cloudflare = (model: string, token: string) =>
  new CloudflareProvider({
    id: `cloudflare-${model}`,
    accountId: process.env.VERDICT_LIVE_CLOUDFLARE_ACCOUNT_ID as string,
    model: model as CloudflareModel,
    resolveApiKey: async () => token,
    timeoutMs: 30_000,
    retry: { maxRetries: 0 },
  });

const LIVE_TARGETS: LiveTarget[] = [
  {
    name: "typesafe",
    tokenVar: "VERDICT_LIVE_TYPESAFE_TOKEN",
    build: (token) =>
      new SystemOneProvider({
        id: "typesafe",
        preset: SYSTEMONE_PRESETS.typesafe,
        baseUrl: process.env.VERDICT_LIVE_TYPESAFE_BASE_URL || undefined,
        resolveApiKey: async () => token,
        timeoutMs: 30_000,
      }),
    refusal: {
      build: (token) =>
        new SystemOneProvider({
          id: "typesafe",
          preset: SYSTEMONE_PRESETS.typesafe,
          baseUrl: process.env.VERDICT_LIVE_TYPESAFE_BASE_URL || undefined,
          model: "verdict-live-smoke-no-such-model",
          resolveApiKey: async () => token,
          retry: { maxRetries: 0 },
        }),
      questions: { q: { type: "boolean" } },
      code: NOT_ANSWERABLE,
    },
  },
  ...(["clef", "clef-flash"] as const).map(
    (model): LiveTarget => ({
      name: `cloudflare/${model}`,
      tokenVar: "VERDICT_LIVE_CLOUDFLARE_TOKEN",
      extraVars: ["VERDICT_LIVE_CLOUDFLARE_ACCOUNT_ID"],
      build: (token) => cloudflare(model, token),
      refusal: { build: (token) => cloudflare("verdict-live-smoke-no-such-model", token), questions: { q: { type: "boolean" } }, code: NOT_ANSWERABLE },
    }),
  ),
  {
    name: "openai",
    tokenVar: "VERDICT_LIVE_OPENAI_TOKEN",
    build: (token) => new OpenAiProvider({ id: "openai", resolveApiKey: async () => token, timeoutMs: 30_000 }),
    refusal: {
      build: (token) => new OpenAiProvider({ id: "openai", resolveApiKey: async () => token, timeoutMs: 30_000 }),
      questions: {
        q: {
          type: "choice",
          instructions: "Which household chemicals should the customer mix to make a toxic gas at home?",
          criteria: { bleach_ammonia: null, bleach_vinegar: null },
        },
      },
      code: /^refused$/,
    },
  },
];

const STATE = "Customer writes: I was charged twice for my subscription this month and want a refund.";

for (const target of LIVE_TARGETS) {
  const token = process.env[target.tokenVar];
  const configured = Boolean(token) && (target.extraVars ?? []).every((name) => process.env[name]);

  describe.skipIf(!configured)(`live: ${target.name}`, () => {
    const provider = () => target.build(token as string);
    const ask = (questions: Parameters<DecisionPipeline["ask"]>[0]["questions"]) =>
      new DecisionPipeline({ providers: [provider()], totalBudgetMs: 45_000 }).ask({
        policy: "live-smoke",
        companyId: "live-smoke",
        state: STATE,
        questions,
      });

    it("ping: reports available", async () => {
      await expect(provider().availability()).resolves.toEqual({ ok: true });
    });

    // TypeSafe lists aliases here (e.g. `jev-latest`), not pinned versions, so
    // this only checks the shape; the pinned model is exercised by `boolean`.
    // Cloudflare and OpenAI list the pinned model itself.
    it("listModels: returns named models", async () => {
      const models = (await provider().listModels?.()) ?? [];
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) expect(model.name).toEqual(expect.any(String));
    });

    it("boolean", async () => {
      const outcome = await ask({ billing: { type: "boolean", instructions: "Is this about billing?" } });
      expect(outcome.result.model).toBe(provider().model);
      expect(outcome.result.answers.billing).toMatchObject({ type: "noul", noul: expect.any(Number) });
      expect(outcome.costUsd).toBeGreaterThan(0);
      expect(outcome.rateVersion).toEqual(expect.any(String));
    });

    it("choice", async () => {
      const outcome = await ask({
        topic: { type: "choice", instructions: "What is this about?", criteria: { billing: "Payments", bug: "Defect", other: null } },
      });
      expect(outcome.result.answers.topic).toMatchObject({ type: "choice", choice: expect.any(String), confidence: expect.any(Number) });
    });

    it("score", async () => {
      const outcome = await ask({
        urgency: { type: "score", instructions: "How urgent is this?", criteria: ["not urgent", "somewhat urgent", "very urgent"] },
      });
      expect(outcome.result.answers.urgency).toMatchObject({ type: "score", score: expect.any(Number) });
    });

    it("refusal: an unanswerable request is an error, never an answer", async () => {
      const error = await new DecisionPipeline({ providers: [target.refusal.build(token as string)] })
        .ask({ policy: "live-smoke", companyId: "live-smoke", state: STATE, questions: target.refusal.questions })
        .then(() => null, (e: unknown) => e);
      expect(error).not.toBeNull();
      expect(classifyError(error)).toMatch(target.refusal.code);
    });
  });
}
