import { describe, expect, it } from "vitest";
import { DecisionPipeline } from "../../src/decision/pipeline.js";
import type { DecisionProvider } from "../../src/decision/provider.js";
import { classifyError } from "../../src/decision/errors.js";
import { SYSTEMONE_PRESETS } from "../../src/decision/providers/presets.js";
import { SystemOneProvider } from "../../src/decision/providers/systemone.js";

/**
 * L3 live smoke (plan 2.3b): ping, listModels, one boolean, one choice, one
 * score and one refusal per provider whose `VERDICT_LIVE_<PROVIDER>_TOKEN` is
 * set. A provider without a token is skipped, not failed. G3 adds Cloudflare
 * and OpenAI rows.
 *
 * Output is safe to paste into a PR: assertions print only shapes and
 * classified error codes, never tokens or raw provider bodies.
 */

interface LiveTarget {
  name: string;
  tokenVar: string;
  build(token: string): DecisionProvider;
}

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
  },
];

const STATE = "Customer writes: I was charged twice for my subscription this month and want a refund.";

for (const target of LIVE_TARGETS) {
  const token = process.env[target.tokenVar];

  describe.skipIf(!token)(`live: ${target.name}`, () => {
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
      const unknownModel = new SystemOneProvider({
        id: target.name,
        preset: SYSTEMONE_PRESETS.typesafe,
        baseUrl: process.env.VERDICT_LIVE_TYPESAFE_BASE_URL || undefined,
        model: "verdict-live-smoke-no-such-model",
        resolveApiKey: async () => token as string,
        retry: { maxRetries: 0 },
      });
      const error = await new DecisionPipeline({ providers: [unknownModel] })
        .ask({ policy: "live-smoke", companyId: "live-smoke", state: STATE, questions: { q: { type: "boolean" } } })
        .then(() => null, (e: unknown) => e);
      expect(error).not.toBeNull();
      expect(classifyError(error)).toMatch(/^(provider-error-4\d\d|validation-failed)$/);
    });
  });
}
