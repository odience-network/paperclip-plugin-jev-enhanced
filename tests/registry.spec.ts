import { describe, expect, it, vi } from "vitest";
import { parseVerdictConfig, policyConfigFor } from "../src/config.js";
import { DecisionPipeline } from "../src/decision/pipeline.js";
import type { DecisionProvider, ProviderCapabilities } from "../src/decision/provider.js";
import { createInMemoryVerdictCache } from "../src/decision/cache.js";
import {
  buildPolicyProviders,
  defaultProviderId,
  effectiveProviders,
  providerBinding,
  providerDisclosure,
  resolvePolicyProviderIds,
  validateProviderConfig,
} from "../src/decision/registry.js";
import { CoreProvider } from "../src/decision/providers/core.js";
import {
  DecisionRefusalError,
  errorClassOf,
  MissingApiKeyError,
  ProviderConnectionError,
  ProviderHttpError,
  VerdictValidationError,
} from "../src/decision/errors.js";
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

describe("registry: legacy config shim", () => {
  it("reads top-level apiKeyRef/model/baseUrl as an implicit typesafe provider", () => {
    const config = parseVerdictConfig({ apiKeyRef: "ref", model: "jev-latest", baseUrl: "https://proxy.example.com" });
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
    const legacy = validateProviderConfig(parseVerdictConfig({ apiKeyRef: "ref" }), undefined);
    expect(legacy.errors).toEqual([]);
    expect(legacy.warnings).toEqual([expect.stringMatching(/deprecated/)]);

    const both = validateProviderConfig(
      parseVerdictConfig({ apiKeyRef: "ref", providers: { typesafe: { kind: "systemone", apiKeyRef: "ref" } } }),
      undefined,
    );
    expect(both.warnings).toEqual([expect.stringMatching(/ignored/)]);
  });

  it("an empty config still resolves to the typesafe provider, with no warnings", () => {
    const config = parseVerdictConfig({});
    expect(defaultProviderId(config)).toBe("typesafe");
    expect(validateProviderConfig(config, undefined)).toEqual({ errors: [], warnings: [] });
  });
});

describe("registry: resolution", () => {
  const config = parseVerdictConfig({
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
    const coreOnly = parseVerdictConfig({ providers: { core: { kind: "core" } } });
    const [provider] = buildPolicyProviders(coreOnly, "ping", runtime);
    expect(provider).toBeInstanceOf(CoreProvider);
  });

  it("reports unknown provider references and core-as-default on a host without the capability", () => {
    const bad = parseVerdictConfig({
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

    const onCapableHost = validateProviderConfig(parseVerdictConfig({ providers: { core: { kind: "core" } }, defaultProvider: "core" }), hostWithDecisions);
    expect(onCapableHost).toEqual({ errors: [], warnings: [] });
  });

  it("allows only pinned TypeSafe models, after alias resolution", () => {
    const withModel = (model: string) =>
      validateProviderConfig(parseVerdictConfig({ providers: { typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "r", model } } }), undefined);
    for (const model of ["jev-1.13.0", "jev-1.14.0", "jev-latest", "latest", "jev-preview"]) {
      expect(withModel(model).errors).toEqual([]);
    }
    expect(withModel("jev-1.15.0").errors).toEqual([
      'providers.typesafe: model "jev-1.15.0" is not an allowed typesafe model (jev-1.13.0, jev-1.14.0).',
    ]);
    // The deprecated top-level model goes through the same check.
    expect(validateProviderConfig(parseVerdictConfig({ apiKeyRef: "r", model: "jev-1.12.0" }), undefined).errors).toHaveLength(1);
    // Another SystemOne server reusing the preset's defaults has its own models.
    const elsewhere = parseVerdictConfig({
      providers: { local: { kind: "systemone", preset: "typesafe", baseUrl: "http://localhost:8000", authStyle: "none", model: "custom-decider-1" } },
    });
    expect(validateProviderConfig(elsewhere, undefined).errors).toEqual([]);
  });

  it("keeps jev-1.13.0 the default and resolves every alias to it, never to the provider-side alias", () => {
    const modelFor = (model?: string) =>
      buildPolicyProviders(parseVerdictConfig({ providers: { typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "r", model } } }), "ping", runtime)[0].model;
    expect(modelFor()).toBe("jev-1.13.0");
    for (const alias of ["jev-latest", "latest", "jev-preview"]) expect(modelFor(alias)).toBe("jev-1.13.0");
    expect(modelFor("jev-1.14.0")).toBe("jev-1.14.0");
  });

  it("rejects provider kinds this build can't construct yet", () => {
    expect(() => parseVerdictConfig({ providers: { cf: { kind: "cloudflare" } } })).toThrow();
  });
});

describe("registry: cleartext credentials and disclosures (ODIAA-2473 F3)", () => {
  const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

  it.each([
    ["systemone with a key", { kind: "systemone", preset: "typesafe", apiKeyRef: "ref", baseUrl: "http://proxy.example.com" }],
    ["systemone on the preset's bearer auth", { kind: "systemone", preset: "typesafe", baseUrl: "http://proxy.example.com" }],
    ["systemone x-api-key", { kind: "systemone", preset: "typesafe", authStyle: "x-api-key", baseUrl: "http://proxy.example.com" }],
    ["systemone none, but a key bound", { kind: "systemone", preset: "typesafe", authStyle: "none", apiKeyRef: "ref", baseUrl: "http://proxy.example.com" }],
    ["cloudflare", { kind: "cloudflare", accountId: ACCOUNT_ID, apiKeyRef: "ref", baseUrl: "http://gateway.example.com" }],
    ["openai", { kind: "openai", apiKeyRef: "ref", baseUrl: "http://proxy.example.com/v1" }],
  ])("rejects an http: baseUrl for a provider that sends a credential: %s", (_name, provider) => {
    expect(() => parseVerdictConfig({ providers: { subject: provider } })).toThrow(/baseUrl must be https:/);
  });

  it("rejects an http: legacy top-level baseUrl, which is read as the bearer typesafe provider", () => {
    expect(() => parseVerdictConfig({ apiKeyRef: "ref", baseUrl: "http://proxy.example.com" })).toThrow(/baseUrl must be https:/);
  });

  it("allows http: only for an unauthenticated provider, and https: for any", () => {
    const config = parseVerdictConfig({
      providers: {
        local: { kind: "systemone", preset: "typesafe", authStyle: "none", baseUrl: "http://decider.example.com" },
        proxied: { kind: "openai", apiKeyRef: "ref", baseUrl: "https://proxy.example.com/v1" },
      },
    });
    expect(Object.keys(config.providers)).toEqual(["local", "proxied"]);
  });

  it("keeps the known host's disclosure when baseUrl stays on it", () => {
    const config = parseVerdictConfig({
      providers: {
        ts: { kind: "systemone", preset: "typesafe", apiKeyRef: "ref", baseUrl: "https://api.typesafe.ai/" },
        oa: { kind: "openai", apiKeyRef: "ref", baseUrl: "https://api.openai.com/v1" },
      },
    });
    expect(providerDisclosure(config.providers.ts)).toMatch(/^Sends redacted state text to TypeSafe/);
    expect(providerDisclosure(config.providers.oa)).toMatch(/^Sends redacted state text to OpenAI .*30 days/);
  });

  it("names the custom origin, with unknown retention, when baseUrl moves a provider off its known host", () => {
    const config = parseVerdictConfig({
      providers: {
        ts: { kind: "systemone", preset: "typesafe", apiKeyRef: "ref", baseUrl: "https://proxy.example.com/typesafe" },
        cf: { kind: "cloudflare", accountId: ACCOUNT_ID, apiKeyRef: "ref", baseUrl: "https://gateway.example.net/v1/acct/gw" },
        oa: { kind: "openai", apiKeyRef: "ref", baseUrl: "https://llm.example.org:8443/v1" },
      },
    });
    expect(providerDisclosure(config.providers.ts)).toBe(
      "Sends redacted state text to https://proxy.example.com (custom base URL; retention unknown).",
    );
    expect(providerDisclosure(config.providers.cf)).toBe(
      "Sends redacted state text to https://gateway.example.net (custom base URL; retention unknown).",
    );
    expect(providerDisclosure(config.providers.oa)).toBe(
      "Sends redacted state text to https://llm.example.org:8443 (custom base URL; retention unknown).",
    );
  });
});

describe("policyConfigFor: provider-bound thresholds and mode", () => {
  const config = parseVerdictConfig({
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

  it("treats the typesafe preset on the pinned default model as the baseline and everything else as not", () => {
    const [typesafeProvider] = buildPolicyProviders(parseVerdictConfig({}), "ping", runtime);
    expect(providerBinding(typesafeProvider)).toEqual({
      key: "typesafe/jev-1.13.0",
      defaultsKey: "typesafe/jev-1.13.0",
      confidence: "native",
      baseline: true,
    });
    expect(providerBinding(new CoreProvider("core", undefined)).baseline).toBe(false);
  });

  it("holds typesafe/jev-1.14.0 in shadow until it has thresholds of its own", () => {
    const [jev114] = buildPolicyProviders(
      parseVerdictConfig({ providers: { typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "r", model: "jev-1.14.0" } } }),
      "ping",
      runtime,
    );
    const binding = providerBinding(jev114);
    expect(binding).toEqual({ key: "typesafe/jev-1.14.0", defaultsKey: "typesafe/jev-1.14.0", confidence: "native", baseline: false });
    expect(policyConfigFor(config, "issue-triage", binding)).toMatchObject({ mode: "shadow" });

    const calibrated = parseVerdictConfig({
      policies: { "issue-triage": { mode: "suggest", thresholds: { confidenceMin: 0.7, "typesafe/jev-1.14.0": { confidenceMin: 0.75 } } } },
    });
    expect(policyConfigFor(calibrated, "issue-triage", binding)).toMatchObject({ mode: "suggest", thresholds: { confidenceMin: 0.75 } });
  });
});

describe("pipeline: fallback chain and cache", () => {
  it("falls back to the next provider on an outage and reports who was asked, who answered and why", async () => {
    const primary = scriptedProvider("primary", { fail: new ProviderConnectionError("primary") });
    const fallback = scriptedProvider("fallback");
    const pipeline = new DecisionPipeline({ providers: [primary, fallback] });

    const outcome = await pipeline.ask({ policy: "ping", companyId: "c1", state: "s", questions: { pong: { type: "boolean" } } });

    expect(primary.decide).toHaveBeenCalledTimes(1);
    expect(outcome.provider).toBe(fallback);
    expect(outcome.requestedProvider).toBe(primary);
    expect(outcome.fallbackFrom).toBe("transport");
    expect(outcome.rateVersion).toBe("fallback-rates-v1");
  });

  it.each([
    { error: new ProviderHttpError("p", 503), errorClass: "http_5xx" },
    { error: new ProviderHttpError("p", 429), errorClass: "rate_limited" },
    { error: new VerdictValidationError("bad body"), errorClass: "invalid_output" },
  ])("falls back on $errorClass", async ({ error, errorClass }) => {
    const primary = scriptedProvider("primary", { fail: error });
    const fallback = scriptedProvider("fallback");

    const outcome = await new DecisionPipeline({ providers: [primary, fallback] }).ask({
      policy: "ping",
      companyId: "c1",
      state: "s",
      questions: { pong: { type: "boolean" } },
    });

    expect(outcome.provider).toBe(fallback);
    expect(outcome.fallbackFrom).toBe(errorClass);
  });

  it.each([
    { error: new DecisionRefusalError("p", ["pong"]), errorClass: "refusal" },
    { error: new ProviderHttpError("p", 401), errorClass: "auth_config" },
    { error: new MissingApiKeyError(), errorClass: "auth_config" },
    { error: new ProviderHttpError("p", 422), errorClass: "invalid_request" },
    { error: new Error("bug"), errorClass: "unknown" },
  ])("does not fall back on $errorClass", async ({ error, errorClass }) => {
    const primary = scriptedProvider("primary", { fail: error });
    const fallback = scriptedProvider("fallback");

    const thrown = await new DecisionPipeline({ providers: [primary, fallback] })
      .ask({ policy: "ping", companyId: "c1", state: "s", questions: { pong: { type: "boolean" } } })
      .catch((e: unknown) => e);

    expect(thrown).toBe(error);
    expect(errorClassOf(thrown)).toBe(errorClass);
    expect(fallback.decide).not.toHaveBeenCalled();
  });

  it("shares one time budget across the whole chain instead of one per provider", async () => {
    const hang = (id: string, failAfterMs?: number) => {
      const provider = scriptedProvider(id);
      provider.decide.mockImplementation(
        (_req: unknown, opts: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            if (failAfterMs !== undefined) setTimeout(() => reject(new ProviderConnectionError(id)), failAfterMs);
            opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
          }),
      );
      return provider;
    };
    const first = hang("first", 40);
    const second = hang("second");
    const third = hang("third");

    const started = Date.now();
    const thrown = await new DecisionPipeline({ providers: [first, second, third], totalBudgetMs: 120 })
      .ask({ policy: "ping", companyId: "c1", state: "s", questions: { pong: { type: "boolean" } } })
      .catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    // The second provider only got what the first left, and the third none.
    expect(elapsed).toBeGreaterThanOrEqual(110);
    expect(elapsed).toBeLessThan(220);
    expect(second.decide).toHaveBeenCalledTimes(1);
    expect(third.decide).not.toHaveBeenCalled();
    expect(errorClassOf(thrown)).toBe("transport");
  });

  it("records a capability skip as the reason a fallback answered", async () => {
    const small = scriptedProvider("small", { caps: { maxQuestions: 0 } });
    const fallback = scriptedProvider("fallback");
    const outcome = await new DecisionPipeline({ providers: [small, fallback] }).ask({
      policy: "ping",
      companyId: "c1",
      state: "s",
      questions: { pong: { type: "boolean" } },
    });
    expect(outcome.fallbackFrom).toBe("capability-max-questions");
  });

  it("skips a provider whose caps don't fit and surfaces the first real failure over a capability skip", async () => {
    const small = scriptedProvider("small", { caps: { maxQuestions: 0 } });
    const broken = scriptedProvider("broken", { fail: new ProviderConnectionError("broken") });
    const pipeline = new DecisionPipeline({ providers: [small, broken] });

    await expect(pipeline.ask({ policy: "ping", companyId: "c1", state: "s", questions: { pong: { type: "boolean" } } })).rejects.toBeInstanceOf(ProviderConnectionError);
    expect(small.decide).not.toHaveBeenCalled();
  });

  it("keys the cache by provider, so two providers never share an answer", async () => {
    const cache = createInMemoryVerdictCache();
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
  const suggestConfig = parseVerdictConfig({ policies: { ping: { mode: "suggest", thresholds: { pong: 0.5 } } } });

  it("records the answering fallback in the ledger and holds an uncalibrated fallback in shadow", async () => {
    const db = createFakeDb();
    const suggestLog = vi.fn();
    const primary = scriptedProvider("typesafe", { preset: "typesafe", fail: new ProviderHttpError("typesafe", 503) });
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
      requestedProvider: "typesafe",
      fallbackFrom: "http_5xx",
      errorClass: null,
      providerKind: "systemone",
      model: "local-model",
      mode: "shadow",
      rateVersion: "local-rates-v1",
      outcome: "observed",
    });
    expect(row?.decisionGroupId).toBe(row?.id);
  });

  it("records the error class on an error row", async () => {
    const db = createFakeDb();
    const primary = scriptedProvider("typesafe", { preset: "typesafe", fail: new ProviderHttpError("typesafe", 401) });
    const fallback = scriptedProvider("local");
    await expect(
      runPolicy(
        { policy: pingPolicy, state: { message: "ping" }, config: suggestConfig, companyId: "c1", issueId: "i1" },
        { client: new DecisionPipeline({ providers: [primary, fallback] }), db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);

    const row = await getLatestDecision(db, "c1", "i1");
    expect(row).toMatchObject({ outcome: "error", reason: "auth-failed", errorClass: "auth_config", requestedProvider: "typesafe" });
    expect(fallback.decide).not.toHaveBeenCalled();
  });

  it("keeps the configured mode on the baseline provider", async () => {
    const db = createFakeDb();
    const primary = scriptedProvider("typesafe", { preset: "typesafe", model: "jev-1.13.0" });
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
      { policy: pingPolicy, state: { message: "ping" }, config: parseVerdictConfig({}), companyId: "c1", issueId: "i1" },
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
      { policy: pingPolicy, state: { message: "ping" }, config: parseVerdictConfig({}), companyId: "c1", issueId: "i1" },
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
