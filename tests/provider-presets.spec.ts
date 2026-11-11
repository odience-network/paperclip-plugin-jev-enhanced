import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseVerdictConfig, policyConfigFor } from "../src/config.js";
import { classifyError } from "../src/decision/errors.js";
import { DecisionPipeline } from "../src/decision/pipeline.js";
import type { DecisionProvider } from "../src/decision/provider.js";
import { SYSTEMONE_PRESETS } from "../src/decision/providers/presets.js";
import { buildProvider, providerBinding, validateProviderConfig } from "../src/decision/registry.js";
import type { DecisionQuestions } from "../src/decision/types.js";
import manifest from "../src/manifest.js";
import { startMockSystemOneServer, type MockSystemOneServer } from "./helpers/mock-systemone-server.js";

/**
 * L2 docs-derived fixtures (plan 2.3b) for the Tier B presets. No account
 * exists for any of these providers: every fixture under
 * `tests/fixtures/<preset>/` is hand-written from the provider's published
 * docs (`source: "docs"`), replayed through the in-process mock server, and
 * `fetch` is guarded so a request to anything but the mock fails the suite.
 */

const TIER_B = ["perplexity", "openrouter", "decisions-api", "ollama", "laya", "von", "kev"] as const;
const FIXTURES_DIR = join(__dirname, "fixtures");

interface DocsFixture {
  source: string;
  docsUrl: string;
  notes: string;
  path: string;
  request?: { model: string; state: unknown; questions: DecisionQuestions };
  response: unknown;
}

function loadFixture(preset: string, name: string): DocsFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, preset, `${name}.json`), "utf8")) as DocsFixture;
}

// Any request that is not to the loopback mock server is recorded and
// rejected. Asserted empty after the suite: no real provider is ever called.
const realFetch = globalThis.fetch;
const blockedRequests: string[] = [];
beforeAll(() => {
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") {
      blockedRequests.push(url.origin);
      return Promise.reject(new Error(`blocked non-mock request to ${url.origin}`));
    }
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  expect(blockedRequests).toEqual([]);
});

let server: MockSystemOneServer;
beforeAll(async () => {
  server = await startMockSystemOneServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
});

function providerFor(preset: string, extra: Record<string, unknown> = {}): DecisionProvider {
  const config = parseVerdictConfig({
    providers: { subject: { kind: "systemone", preset, apiKeyRef: "ref", baseUrl: server.baseUrl, ...extra } },
  });
  return buildProvider("subject", config.providers.subject, {
    resolveSecret: async () => "sk-fixture-test",
    timeoutMs: 2_000,
    retry: { maxRetries: 0, backoffInitialMs: 1, backoffMaxMs: 1 },
  });
}

/** Replays `fixture.response` for one ask with the fixture's request. */
async function replay(preset: string, fixture: DocsFixture) {
  server.respondWith(() => ({ body: fixture.response }));
  const request = fixture.request!;
  const provider = providerFor(preset, { model: request.model });
  const pipeline = new DecisionPipeline({ providers: [provider] });
  return pipeline.ask({ policy: "fixture", companyId: "c1", state: request.state, questions: request.questions });
}

describe("Tier B presets: registry and config", () => {
  it.each(TIER_B)("%s is a fixtures-only preset with a docs URL and disclosure", (name) => {
    const preset = SYSTEMONE_PRESETS[name];
    expect(preset.verification).toBe("fixtures");
    expect(preset.docsUrl).toMatch(/^https:\/\//);
    expect(preset.disclosure.length).toBeGreaterThan(20);
  });

  it("the manifest's preset enum lists exactly the registered presets", () => {
    const schema = manifest.instanceConfigSchema as {
      properties: { providers: { additionalProperties: { properties: { preset: { enum: string[] } } } } };
    };
    const providers = schema.properties.providers;
    expect([...providers.additionalProperties.properties.preset.enum].sort()).toEqual(Object.keys(SYSTEMONE_PRESETS).sort());
  });

  it.each(TIER_B)("%s defaults point at the documented host and path", async (name) => {
    const preset = SYSTEMONE_PRESETS[name];
    const urls: string[] = [];
    const config = parseVerdictConfig({
      providers: {
        subject: {
          kind: "systemone",
          preset: name,
          apiKeyRef: "ref",
          ...(preset.defaultModel ? {} : { model: "typesafe/jev-1.13" }),
          ...(preset.baseUrl ? {} : { baseUrl: "http://laya.internal:8000" }),
        },
      },
    });
    const provider = buildProvider("subject", config.providers.subject, {
      resolveSecret: async () => "sk-fixture-test",
      retry: { maxRetries: 0, backoffInitialMs: 1, backoffMaxMs: 1 },
      // Captures the URL and fails: never reaches the network.
      fetchImpl: async (input) => {
        urls.push(String(input));
        throw new Error("captured");
      },
    });
    await provider.decide({ state: "s", questions: { q: { type: "boolean" } }, model: provider.model }, { signal: AbortSignal.timeout(1_000) }).catch(() => {});
    expect(urls).toEqual([`${preset.baseUrl || "http://laya.internal:8000"}${preset.path}`]);
  });

  it("is selectable in config; validation requires a model for decisions-api and a baseUrl for laya, and warns for every Tier B preset", () => {
    const config = parseVerdictConfig({
      providers: {
        pplx: { kind: "systemone", preset: "perplexity", apiKeyRef: "ref" },
        agg: { kind: "systemone", preset: "decisions-api", apiKeyRef: "ref" },
        laya: { kind: "systemone", preset: "laya" },
        "local-clef": { kind: "systemone", preset: "ollama", baseUrl: "http://ollama:11434", model: "clef" },
      },
      defaultProvider: "pplx",
    });
    const report = validateProviderConfig(config, {});
    expect(report.errors).toEqual([
      'providers.agg: preset "decisions-api" needs a model.',
      'providers.laya: preset "laya" needs a baseUrl.',
    ]);
    expect(report.warnings.filter((warning) => warning.includes("not live-verified"))).toHaveLength(4);
    expect(() => buildProvider("agg", config.providers.agg, { resolveSecret: async () => "k" })).toThrow(/set model/);
    expect(() => buildProvider("laya", config.providers.laya, { resolveSecret: async () => "k" })).toThrow(/set baseUrl/);
  });

  it.each(TIER_B)("%s holds a promoted policy at shadow: no thresholds exist for it", (name) => {
    const config = parseVerdictConfig({
      policies: { "issue-triage": { mode: "suggest", thresholds: { confidenceMin: 0.7 } } },
    });
    const provider = providerFor(name, SYSTEMONE_PRESETS[name].defaultModel ? {} : { model: "typesafe/jev-1.13" });
    expect(policyConfigFor(config, "issue-triage", providerBinding(provider)).mode).toBe("shadow");
  });
});

describe.each(TIER_B)("L2 docs fixtures: %s", (preset) => {
  const files = readdirSync(join(FIXTURES_DIR, preset)).map((file) => file.replace(/\.json$/, ""));

  it.each(files)("%s.json is marked source: docs with its doc URL", (name) => {
    const fixture = loadFixture(preset, name);
    expect(fixture.source).toBe("docs");
    expect(fixture.docsUrl).toMatch(/^https:\/\//);
    expect(fixture.path).toMatch(/^\//);
  });

  it("decide.json replays through the preset: documented path, pinned model, valid answers", async () => {
    const fixture = loadFixture(preset, "decide");
    const outcome = await replay(preset, fixture);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].path).toBe(fixture.path);
    expect((server.requests[0].body as { model: string }).model).toBe(fixture.request!.model);
    expect(outcome.result.model).toBe(fixture.request!.model);
    expect(Object.keys(outcome.result.answers).sort()).toEqual(Object.keys(fixture.request!.questions).sort());
  });
});

describe("L2 docs fixtures: preset-specific response variants", () => {
  it("openrouter: maps the dated model echo to the pinned slug, drops routing metadata, and charges usage.cost", async () => {
    const outcome = await replay("openrouter", loadFixture("openrouter", "decide"));
    expect(outcome.result.model).toBe("typesafe/jev-1.13");
    expect(outcome.result.answers.is_bug).toEqual({ type: "noul", noul: 0.96 });
    expect(outcome.result.usage).toEqual({ input_tokens: 476, output_tokens: 70 });
    expect(outcome.costUsd).toBe(0.000019992);
    expect(outcome.rateVersion).toBe("openrouter-usage-cost");
  });

  it("openrouter: a model echo that is not a dated variant of the pin is still a mismatch", async () => {
    const fixture = loadFixture("openrouter", "decide");
    const response = { ...(fixture.response as Record<string, unknown>), model: "typesafe/jev-1.14-20261101" };
    const error = await replay("openrouter", { ...fixture, response }).catch((e) => e);
    expect(classifyError(error)).toBe("validation-failed");
  });

  it("openrouter: a refusal answer fails the decision instead of producing an answer", async () => {
    const error = await replay("openrouter", loadFixture("openrouter", "refusal")).catch((e) => e);
    expect(classifyError(error)).toBe("validation-failed");
    expect(String(error.message)).toContain('refused question "is_bug"');
  });

  it("decisions-api: unwraps the envelope and charges creditsUsed at $1 per 10,000", async () => {
    const outcome = await replay("decisions-api", loadFixture("decisions-api", "decide"));
    expect(outcome.result.answers.route).toMatchObject({ type: "choice", choice: "billing" });
    expect(outcome.costUsd).toBeCloseTo(0.0001, 12);
    expect(outcome.rateVersion).toBe("decisions-api-credits");
  });

  it("decisions-api: an error envelope on HTTP 200 fails without carrying the provider's message", async () => {
    const error = await replay("decisions-api", loadFixture("decisions-api", "error")).catch((e) => e);
    expect(classifyError(error)).toBe("validation-failed");
    expect(String(error.message)).toBe("decisions-api.dev returned error code 402");
  });

  it("von: gates on noul_raw (the calibrated posterior), not the banded noul, and drops truncation", async () => {
    const outcome = await replay("von", loadFixture("von", "decide"));
    expect(outcome.result.answers.needs_action).toEqual({ type: "noul", noul: 0.97 });
    expect(outcome.result).not.toHaveProperty("truncation");
  });

  it("laya: confidence is 1 minus the normalised entropy of the distribution", async () => {
    const outcome = await replay("laya", loadFixture("laya", "decide"));
    for (const name of ["queue", "urgency"]) {
      const answer = outcome.result.answers[name] as { probabilities: Record<string, number>; confidence: number };
      const ps = Object.values(answer.probabilities);
      const entropy = -ps.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0);
      expect(answer.confidence).toBeCloseTo(1 - entropy / Math.log(ps.length), 3);
    }
  });

  it("ollama: lists models from /api/tags", async () => {
    const fixture = loadFixture("ollama", "models");
    server.respondWith(() => ({ body: fixture.response }));
    const provider = providerFor("ollama");
    const models = await provider.listModels?.();
    expect(models?.map((model) => model.name)).toEqual(["clef:latest"]);
    expect(server.requests[0].path).toBe("/api/tags");
    expect(server.requests[0].headers.authorization).toBeUndefined();
  });

  it("kev: charges Opper's input-only rate card", async () => {
    const outcome = await replay("kev", loadFixture("kev", "decide"));
    expect(outcome.costUsd).toBeCloseTo((23 * 0.042) / 1_000_000, 12);
    expect(outcome.rateVersion).toBe("kev-opper-2026-09");
  });
});
