import { describe, expect, it, vi } from "vitest";
import { parseVerdictConfig } from "../src/config.js";
import { DecisionPipeline } from "../src/decision/pipeline.js";
import type { DecisionProvider, ProviderCapabilities } from "../src/decision/provider.js";
import { buildPolicyPipeline } from "../src/decision/registry.js";
import { CapabilityError, ProviderConnectionError, ProviderHttpError, classifyError } from "../src/decision/errors.js";
import { runPolicy } from "../src/policies/run.js";
import { pingPolicy } from "../src/policies/ping.js";
import { getLatestDecision, getModeSplit, listDecisionHistory, listLatestDecisionsByPolicy } from "../src/ledger/index.js";
import { createFakeDb } from "./helpers/fake-db.js";

const CAPS: ProviderCapabilities = {
  questionTypes: ["boolean", "choice", "score"],
  maxQuestions: 100,
  maxChoiceOptions: 100,
  maxScoreLevels: 10,
  maxRequestBytes: 1_000_000,
  images: false,
  confidence: "native",
  probabilities: true,
  billing: "plugin",
};

function scriptedProvider(
  id: string,
  options: { noul?: number; fail?: Error; caps?: Partial<ProviderCapabilities>; preset?: string; model?: string } = {},
): DecisionProvider & { decide: ReturnType<typeof vi.fn> } {
  const model = options.model ?? `${id}-model`;
  return {
    id,
    kind: "systemone",
    preset: options.preset ?? "custom",
    model,
    capabilities: { ...CAPS, ...options.caps },
    verification: "fixtures",
    availability: async () => ({ ok: true }),
    decide: vi.fn(async () => {
      if (options.fail) throw options.fail;
      return {
        model,
        answers: { pong: { type: "noul" as const, noul: options.noul ?? 0.9 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      };
    }),
    estimateCostUsd: (usage) => ({ usd: usage.input_tokens / 1_000_000, rateVersion: `${id}-rates-v1` }),
  };
}

const ASK = { policy: "ping", companyId: "c1", state: "s", questions: { pong: { type: "boolean" as const } } };

describe("DecisionPipeline.askShadow", () => {
  it("asks only the shadow provider, never the primary or a fallback", async () => {
    const primary = scriptedProvider("primary");
    const shadow = scriptedProvider("shadow");
    const pipeline = new DecisionPipeline({ providers: [primary], shadows: [shadow] });

    const outcome = await pipeline.askShadow(shadow, ASK);

    expect(outcome.provider).toBe(shadow);
    expect(outcome.requestedProvider).toBe(shadow);
    expect(outcome.fallbackFrom).toBeNull();
    expect(primary.decide).not.toHaveBeenCalled();
  });

  it("does not fall back when the shadow fails with a fallback-eligible error", async () => {
    const primary = scriptedProvider("primary");
    const shadow = scriptedProvider("shadow", { fail: new ProviderHttpError("shadow", 503) });
    const pipeline = new DecisionPipeline({ providers: [primary, scriptedProvider("fallback")], shadows: [shadow] });

    await expect(pipeline.askShadow(shadow, ASK)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(primary.decide).not.toHaveBeenCalled();
  });

  it("throws a CapabilityError when the shadow can't take the question set", async () => {
    const shadow = scriptedProvider("shadow", { caps: { maxQuestions: 0 } });
    const pipeline = new DecisionPipeline({ providers: [scriptedProvider("primary")], shadows: [shadow] });
    await expect(pipeline.askShadow(shadow, ASK)).rejects.toBeInstanceOf(CapabilityError);
    expect(shadow.decide).not.toHaveBeenCalled();
  });

  it("redacts the shadow's questions and checks its answers like the primary's", async () => {
    const shadow = scriptedProvider("shadow");
    const pipeline = new DecisionPipeline({ providers: [scriptedProvider("primary")], shadows: [shadow], redactionPatterns: ["SECRET-\\d"] });

    await pipeline.askShadow(shadow, { ...ASK, questions: { pong: { type: "boolean", instructions: "is SECRET-1 live?" } } });
    expect(JSON.stringify(shadow.decide.mock.calls[0][0].questions)).not.toContain("SECRET-1");

    // The scripted shadow answers `pong`, which this question set doesn't ask.
    const error = await pipeline.askShadow(shadow, { ...ASK, questions: { other: { type: "boolean" } } }).catch((e) => e);
    expect(classifyError(error)).toBe("validation-failed");
  });
});

describe("buildPolicyPipeline shadows", () => {
  it("builds the configured shadows minus the policy's primary", () => {
    const config = parseVerdictConfig({
      providers: {
        typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "a" },
        next: { kind: "systemone", preset: "typesafe", apiKeyRef: "a", model: "jev-1.14.0" },
      },
      shadowProviders: ["typesafe", "next"],
    });
    const pipeline = buildPolicyPipeline(config, "ping", { resolveSecret: async () => "key" }, {});
    expect(pipeline.primary.id).toBe("typesafe");
    expect(pipeline.shadows.map((provider) => provider.id)).toEqual(["next"]);
  });
});

describe("runPolicy with shadow providers", () => {
  const suggestConfig = parseVerdictConfig({ policies: { ping: { mode: "suggest", thresholds: { pong: 0.5 } } } });

  async function run(primary: DecisionProvider, shadows: DecisionProvider[], fallbacks: DecisionProvider[] = []) {
    const db = createFakeDb();
    const suggestLog = vi.fn();
    const applyLog = vi.fn();
    const result = await runPolicy(
      { policy: pingPolicy, state: { message: "ping" }, config: suggestConfig, companyId: "c1", issueId: "i1" },
      {
        client: new DecisionPipeline({ providers: [primary, ...fallbacks], shadows }),
        db,
        apply: { log: applyLog },
        suggest: { log: suggestLog },
      },
    );
    const rows = await listDecisionHistory(db, "c1", "i1", 50);
    return { db, result, rows, suggestLog, applyLog };
  }

  it("records each shadow under the primary's decision_group_id, in shadow mode, without acting on it", async () => {
    const primary = scriptedProvider("typesafe", { preset: "typesafe", model: "jev-1.13.0", noul: 0.9 });
    // Disagrees with the primary: a shadow answer must never reach the suggestion.
    const shadow = scriptedProvider("cf-clef", { noul: 0.1 });
    const { result, rows, suggestLog } = await run(primary, [shadow]);

    expect(result).toMatchObject({ outcome: "suggested" });
    expect(suggestLog).toHaveBeenCalledTimes(1);
    const primaryId = (result as { decisionId: string }).decisionId;
    const primaryRow = rows.find((row) => row.id === primaryId);
    const shadowRow = rows.find((row) => row.id !== primaryId);
    expect(primaryRow).toMatchObject({ decisionGroupId: primaryId, provider: "typesafe", outcome: "suggested" });
    expect(shadowRow).toMatchObject({
      decisionGroupId: primaryId,
      provider: "cf-clef",
      requestedProvider: "cf-clef",
      fallbackFrom: null,
      mode: "shadow",
      outcome: "observed",
      model: "cf-clef-model",
      rateVersion: "cf-clef-rates-v1",
      answers: { pong: { type: "noul", noul: 0.1 } },
    });
    expect(shadowRow?.stateHash).toBe(primaryRow?.stateHash);
  });

  it("records a failing shadow as an error row with its class and never falls back for it", async () => {
    const primary = scriptedProvider("typesafe", { preset: "typesafe", model: "jev-1.13.0" });
    const fallback = scriptedProvider("local");
    const shadow = scriptedProvider("openai", { fail: new ProviderConnectionError("openai") });
    const { result, rows } = await run(primary, [shadow], [fallback]);

    expect(result).toMatchObject({ outcome: "suggested" });
    expect(fallback.decide).not.toHaveBeenCalled();
    const shadowRow = rows.find((row) => row.provider === "openai");
    expect(shadowRow).toMatchObject({ outcome: "error", errorClass: "transport", reason: "connection-error", mode: "shadow" });
    expect(shadowRow?.decisionGroupId).toBe((result as { decisionId: string }).decisionId);
  });

  it("still records shadows when the primary fails", async () => {
    const primary = scriptedProvider("typesafe", { preset: "typesafe", fail: new ProviderHttpError("typesafe", 401) });
    const shadow = scriptedProvider("cf-clef");
    const db = createFakeDb();
    await expect(
      runPolicy(
        { policy: pingPolicy, state: { message: "ping" }, config: suggestConfig, companyId: "c1", issueId: "i1" },
        { client: new DecisionPipeline({ providers: [primary], shadows: [shadow] }), db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);

    const rows = await listDecisionHistory(db, "c1", "i1", 50);
    expect(rows.find((row) => row.provider === "typesafe")).toMatchObject({ outcome: "error", errorClass: "auth_config" });
    expect(rows.find((row) => row.provider === "cf-clef")).toMatchObject({ outcome: "observed", mode: "shadow" });
  });

  it("records a shadow that can't take the question set as skipped", async () => {
    const primary = scriptedProvider("typesafe", { preset: "typesafe", model: "jev-1.13.0" });
    const shadow = scriptedProvider("tiny", { caps: { maxQuestions: 0 } });
    const { rows } = await run(primary, [shadow]);
    expect(rows.find((row) => row.provider === "tiny")).toMatchObject({ outcome: "skipped", reason: "capability-max-questions", errorClass: null });
  });

  it("keeps shadow rows out of the latest-decision reads and the mode split", async () => {
    const primary = scriptedProvider("typesafe", { preset: "typesafe", model: "jev-1.13.0" });
    const { db, result } = await run(primary, [scriptedProvider("cf-clef"), scriptedProvider("openai")]);
    const primaryId = (result as { decisionId: string }).decisionId;

    expect((await getLatestDecision(db, "c1", "i1"))?.id).toBe(primaryId);
    expect((await listLatestDecisionsByPolicy(db, "c1", "i1")).map((row) => row.id)).toEqual([primaryId]);
    expect(await getModeSplit(db, "c1")).toEqual({ shadow: 0, suggest: 1, enforce: 0 });
  });
});
