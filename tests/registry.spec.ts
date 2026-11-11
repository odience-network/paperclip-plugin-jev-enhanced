import { describe, expect, it, vi } from "vitest";
import { parseJevConfig, policyConfigFor } from "../src/config.js";
import { DecisionPipeline } from "../src/decision/pipeline.js";
import type { DecisionProvider, ProviderCapabilities } from "../src/decision/provider.js";
import { createInMemoryJevCache } from "../src/decision/cache.js";
import {
  buildPolicyProviders,
  defaultProviderId,
  effectiveProviders,
  providerBinding,
  resolvePolicyProviderIds,
  validateProviderConfig,
} from "../src/decision/registry.js";
import { CoreProvider } from "../src/decision/providers/core.js";
import { SystemOneProvider } from "../src/decision/providers/systemone.js";
import { runPolicy } from "../src/policies/run.js";
import { pingPolicy } from "../src/policies/ping.js";
import { getDecisionById, getLatestDecision } from "../src/ledger/index.js";
import { createFakeDb } from "./helpers/fake-db.js";

const runtime = { resolveSecret: async () => "key" };
const hostWithDecisions = { decisions: { decide: async () => ({ model: "m", answers: {} }) } };

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

/** A scripted in-memory provider for pipeline/runPolicy tests. */
function scriptedProvider(
  id: string,
  options: { noul?: number; fail?: Error; caps?: Partial<ProviderCapabilities>; preset?: string } = {},
): DecisionProvider & { decide: ReturnType<typeof vi.fn> } {
  return {
    id,
    kind: "systemone",
    preset: options.preset ?? "custom",
    model: `${id}-model`,
    capabilities: { ...CAPS, ...options.caps },
    verification: "fixtures",
    availability: async () => ({ ok: true }),
    decide: vi.fn(async () => {
      if (options.fail) throw options.fail;
      return {
        model: `${id}-model`,
        answers: { pong: { type: "noul" as const, noul: options.noul ?? 0.9 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      };
    }),
    estimateCostUsd: (usage) => ({ usd: usage.input_tokens / 1_000_000, rateVersion: `${id}-rates-v1` }),
  };
}

describe("registry: legacy config shim", () => {
  it("reads top-level apiKeyRef/model/baseUrl as an implicit typesafe provider", () => {
    const config = parseJevConfig({ apiKeyRef: "ref", model: "jev-latest", baseUrl: "https://proxy.example.com" });
    expect(effectiveProviders(config)).toEqual({
      legacy: true,
      providers: {
        typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "ref", model: "jev-latest", baseUrl: "https://proxy.example.com" },
      },
    });
    expect(defaultProviderId(config)).toBe("typesafe");

    const [provider] = buildPolicyProviders(config, "ping", runtime);
    expect(provider).toBeInstanceOf(SystemOneProvider);
    expect(provider.model).toBe("jev-1.13.0");
  });

  it("warns that the legacy fields are deprecated, and that they're ignored next to a providers map", () => {
    const legacy = validateProviderConfig(parseJevConfig({ apiKeyRef: "ref" }), undefined);
    expect(legacy.errors).toEqual([]);
    expect(legacy.warnings).toEqual([expect.stringMatching(/deprecated/)]);

    const both = validateProviderConfig(
      parseJevConfig({ apiKeyRef: "ref", providers: { typesafe: { kind: "systemone", apiKeyRef: "ref" } } }),
      undefined,
    );
    expect(both.warnings).toEqual([expect.stringMatching(/ignored/)]);
  });

  it("an empty config still resolves to the typesafe provider, with no warnings", () => {
    const config = parseJevConfig({});
    expect(defaultProviderId(config)).toBe("typesafe");
    expect(validateProviderConfig(config, undefined)).toEqual({ errors: [], warnings: [] });
  });
});

describe("registry: resolution", () => {
  const config = parseJevConfig({
    providers: {
      typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "ref" },
      local: { kind: "systemone", preset: "typesafe", baseUrl: "http://localhost:11434", authStyle: "none", model: "clef" },
      core: { kind: "core" },
    },
    defaultProvider: "typesafe",
    shadowProviders: ["local", "typesafe"],
    policies: {
      "issue-triage": { provider: "local", fallbackProviders: ["core", "typesafe", "local"] },
    },
  });

  it("resolves per-policy provider, fallbacks and shadows, dropping the primary from both lists", () => {
    expect(resolvePolicyProviderIds(config, "issue-triage")).toEqual({
      primary: "local",
      fallbacks: ["core", "typesafe"],
      shadows: ["typesafe"],
    });
    expect(resolvePolicyProviderIds(config, "ping")).toEqual({ primary: "typesafe", fallbacks: [], shadows: ["local"] });
  });

  it("skips core in a fallback chain on a host without the capability, and keeps it where the host has it", () => {
    expect(buildPolicyProviders(config, "issue-triage", runtime).map((p) => p.id)).toEqual(["local", "typesafe"]);
    expect(buildPolicyProviders(config, "issue-triage", { ...runtime, host: hostWithDecisions }).map((p) => p.id)).toEqual([
      "local",
      "core",
      "typesafe",
    ]);
  });

  it("keeps core when it's the only provider, so calls fail as provider-unavailable instead of silently", () => {
    const coreOnly = parseJevConfig({ providers: { core: { kind: "core" } } });
    const [provider] = buildPolicyProviders(coreOnly, "ping", runtime);
    expect(provider).toBeInstanceOf(CoreProvider);
  });

  it("reports unknown provider references and core-as-default on a host without the capability", () => {
    const bad = parseJevConfig({
      providers: { core: { kind: "core" }, typesafe: { kind: "systemone", preset: "nope", apiKeyRef: "r" } },
      defaultProvider: "core",
      shadowProviders: ["ghost"],
      policies: { ping: { provider: "missing", fallbackProviders: ["also-missing"] } },
    });
    const report = validateProviderConfig(bad, undefined);
    expect(report.errors).toEqual([
      'providers.typesafe: unknown preset "nope".',
      'shadowProviders references unknown provider "ghost".',
      'policies.ping.provider references unknown provider "missing".',
      'policies.ping.fallbackProviders references unknown provider "also-missing".',
      'defaultProvider "core" is core, which is unavailable on this host.',
    ]);
    expect(report.warnings).toEqual([expect.stringMatching(/core: unavailable on this host/)]);

    const onCapableHost = validateProviderConfig(parseJevConfig({ providers: { core: { kind: "core" } }, defaultProvider: "core" }), hostWithDecisions);
    expect(onCapableHost).toEqual({ errors: [], warnings: [] });
  });

  it("rejects provider kinds this build can't construct yet", () => {
    expect(() => parseJevConfig({ providers: { cf: { kind: "cloudflare" } } })).toThrow();
  });
});

describe("policyConfigFor: provider-bound thresholds and mode", () => {
  const config = parseJevConfig({
    policies: {
      "issue-triage": {
        mode: "suggest",
        thresholds: {
          confidenceMin: 0.7,
          marginMin: 0.15,
          "typesafe/jev-1.13.0": { confidenceMin: 0.72 },
          "cf-clef/clef-flash": { confidenceMin: 0.8, marginMin: 0.2 },
        },
      },
    },
  });
  const typesafe = { key: "typesafe/jev-1.13.0", confidence: "native" as const, baseline: true };

  it("returns plain numeric thresholds without a binding (unchanged legacy behaviour)", () => {
    expect(policyConfigFor(config, "issue-triage")).toMatchObject({ mode: "suggest", thresholds: { confidenceMin: 0.7, marginMin: 0.15 } });
  });

  it("overlays the provider/model block on the policy defaults", () => {
    expect(policyConfigFor(config, "issue-triage", typesafe)).toMatchObject({
      mode: "suggest",
      thresholds: { confidenceMin: 0.72, marginMin: 0.15 },
    });
    expect(policyConfigFor(config, "issue-triage", { key: "cf-clef/clef-flash", confidence: "native", baseline: false })).toMatchObject({
      mode: "suggest",
      thresholds: { confidenceMin: 0.8, marginMin: 0.2 },
    });
  });

  it("drops to shadow on a non-baseline provider with no thresholds of its own", () => {
    expect(policyConfigFor(config, "issue-triage", { key: "local/clef", confidence: "native", baseline: false })).toMatchObject({
      mode: "shadow",
      thresholds: { confidenceMin: 0.7, marginMin: 0.15 },
    });
  });

  it("forces shadow when the provider reports no confidence, even with thresholds", () => {
    expect(policyConfigFor(config, "issue-triage", { key: "cf-clef/clef-flash", confidence: "none", baseline: false }).mode).toBe("shadow");
  });

  it("treats the typesafe preset as the baseline and everything else as not", () => {
    const [typesafeProvider] = buildPolicyProviders(parseJevConfig({}), "ping", runtime);
    expect(providerBinding(typesafeProvider)).toEqual({ key: "typesafe/jev-1.13.0", confidence: "native", baseline: true });
    expect(providerBinding(new CoreProvider("core", undefined)).baseline).toBe(false);
  });
});

describe("pipeline: fallback chain and cache", () => {
  it("falls back to the next provider on failure and reports who answered", async () => {
    const primary = scriptedProvider("primary", { fail: new Error("boom") });
    const fallback = scriptedProvider("fallback");
    const pipeline = new DecisionPipeline({ providers: [primary, fallback] });

    const outcome = await pipeline.ask({ policy: "ping", companyId: "c1", state: "s", questions: { pong: { type: "boolean" } } });

    expect(primary.decide).toHaveBeenCalledTimes(1);
    expect(outcome.provider).toBe(fallback);
    expect(outcome.rateVersion).toBe("fallback-rates-v1");
  });

  it("skips a provider whose caps don't fit and surfaces the first real failure over a capability skip", async () => {
    const small = scriptedProvider("small", { caps: { maxQuestions: 0 } });
    const broken = scriptedProvider("broken", { fail: new Error("boom") });
    const pipeline = new DecisionPipeline({ providers: [small, broken] });

    await expect(pipeline.ask({ policy: "ping", companyId: "c1", state: "s", questions: { pong: { type: "boolean" } } })).rejects.toThrow("boom");
    expect(small.decide).not.toHaveBeenCalled();
  });

  it("keys the cache by provider, so two providers never share an answer", async () => {
    const cache = createInMemoryJevCache();
    const a = scriptedProvider("a");
    const b = scriptedProvider("b");
    const input = { policy: "ping", companyId: "c1", state: "s", questions: { pong: { type: "boolean" as const } } };

    await new DecisionPipeline({ providers: [a], cache }).ask(input);
    const second = await new DecisionPipeline({ providers: [b], cache }).ask(input);
    const third = await new DecisionPipeline({ providers: [a], cache }).ask(input);

    expect(second.cached).toBe(false);
    expect(third.cached).toBe(true);
    expect(a.decide).toHaveBeenCalledTimes(1);
    expect(b.decide).toHaveBeenCalledTimes(1);
  });
});

describe("runPolicy with providers", () => {
  const suggestConfig = parseJevConfig({ policies: { ping: { mode: "suggest", thresholds: { pong: 0.5 } } } });

  it("records the answering fallback in the ledger and holds an uncalibrated fallback in shadow", async () => {
    const db = createFakeDb();
    const suggestLog = vi.fn();
    const primary = scriptedProvider("typesafe", { preset: "typesafe", fail: new Error("down") });
    const fallback = scriptedProvider("local");
    const result = await runPolicy(
      { policy: pingPolicy, state: { message: "ping" }, config: suggestConfig, companyId: "c1", issueId: "i1" },
      { client: new DecisionPipeline({ providers: [primary, fallback] }), db, apply: { log: vi.fn() }, suggest: { log: suggestLog } },
    );

    expect(result).toMatchObject({ outcome: "observed" });
    expect(suggestLog).not.toHaveBeenCalled();
    const row = await getDecisionById(db, "c1", (result as { decisionId: string }).decisionId);
    expect(row).toMatchObject({
      provider: "local",
      providerKind: "systemone",
      model: "local-model",
      mode: "shadow",
      rateVersion: "local-rates-v1",
      outcome: "observed",
    });
    expect(row?.decisionGroupId).toBe(row?.id);
  });

  it("keeps the configured mode on the baseline provider", async () => {
    const db = createFakeDb();
    const primary = scriptedProvider("typesafe", { preset: "typesafe" });
    const result = await runPolicy(
      { policy: pingPolicy, state: { message: "ping" }, config: suggestConfig, companyId: "c1", issueId: "i1" },
      { client: new DecisionPipeline({ providers: [primary] }), db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
    );
    expect(result).toMatchObject({ outcome: "suggested" });
  });

  it("records a question set no provider can take as skipped with a bounded reason, not an error", async () => {
    const db = createFakeDb();
    const tiny = scriptedProvider("typesafe", { preset: "typesafe", caps: { questionTypes: ["choice"] } });
    const result = await runPolicy(
      { policy: pingPolicy, state: { message: "ping" }, config: parseJevConfig({}), companyId: "c1", issueId: "i1" },
      { client: new DecisionPipeline({ providers: [tiny] }), db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
    );

    expect(result).toEqual({ outcome: "skipped", reason: "capability-question-type" });
    expect(tiny.decide).not.toHaveBeenCalled();
    const row = await getLatestDecision(db, "c1", "i1");
    expect(row).toMatchObject({ outcome: "skipped", reason: "capability-question-type" });
  });

  it("records a null cost and the host invocation id for a host-billed provider", async () => {
    const db = createFakeDb();
    const host = {
      decisions: {
        decide: async () => ({
          model: "host-model",
          answers: { pong: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 3, output_tokens: 1 },
          invocationId: "inv_9",
        }),
      },
    };
    const result = await runPolicy(
      { policy: pingPolicy, state: { message: "ping" }, config: parseJevConfig({}), companyId: "c1", issueId: "i1" },
      { client: new DecisionPipeline({ providers: [new CoreProvider("core", host)] }), db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
    );
    const row = await getDecisionById(db, "c1", (result as { decisionId: string }).decisionId);
    expect(row).toMatchObject({
      provider: "core",
      providerKind: "core",
      model: "host-model",
      costUsd: null,
      rateVersion: null,
      hostInvocationId: "inv_9",
    });
  });
});
