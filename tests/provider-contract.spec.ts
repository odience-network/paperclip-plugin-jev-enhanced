import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { parseVerdictConfig } from "../src/config.js";
import { answeredByFields, DecisionPipeline } from "../src/decision/pipeline.js";
import type { DecisionProvider } from "../src/decision/provider.js";
import { createInMemoryVerdictCache } from "../src/decision/cache.js";
import { buildProvider, type ProviderRuntime } from "../src/decision/registry.js";
import { classifyError, CapabilityError } from "../src/decision/errors.js";
import { CoreProvider, CORE_UNAVAILABLE_REASON, type HostDecisionCapability } from "../src/decision/providers/core.js";
import { runPolicy } from "../src/policies/run.js";
import { pingPolicy } from "../src/policies/ping.js";
import type { DecisionQuestions } from "../src/decision/types.js";
import { createFakeDb } from "./helpers/fake-db.js";
import { plainHttpFetch, startMockSystemOneServer, syntheticSystemOneReply, type MockSystemOneServer } from "./helpers/mock-systemone-server.js";

/**
 * L1 contract suite (plan 2.3b). Every SystemOne-shaped provider configuration
 * runs the same assertions against an in-process mock server: path, auth
 * header, body shape, caps, redaction, no raw state in the ledger, error
 * mapping, timeout, and cost/rate version. G3/G4 add their adapters and
 * presets as new rows in `SYSTEMONE_CASES`.
 */

const TEST_KEY = "sk-contract-test";

interface ContractCase {
  name: string;
  /** Raw `providers.<id>` config, as an operator would write it. */
  providerConfig: (baseUrl: string) => Record<string, unknown>;
  /** Model the case's config asks for, and the pinned one that must go on the wire. */
  expectedModel: string;
  expectedPath: string;
  /** `null` for presets that document no models endpoint. */
  expectedModelsPath: string | null;
  assertAuth: (headers: IncomingHttpHeaders) => void;
  /** Cost of the synthetic reply (1000 input + 10 output tokens). */
  expectedCostUsd: number;
  expectedRateVersion: string | null;
}

const expectBearer = (headers: IncomingHttpHeaders) => {
  expect(headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  expect(headers["x-api-key"]).toBeUndefined();
};
const expectNoAuth = (headers: IncomingHttpHeaders) => {
  expect(headers.authorization).toBeUndefined();
  expect(headers["x-api-key"]).toBeUndefined();
};

/** Tier B presets (G4): built from published docs, never called live. The
 * mock server stands in for each documented host via `baseUrl`. */
function tierBCase(
  preset: string,
  overrides: Partial<ContractCase> & Pick<ContractCase, "expectedModel" | "expectedPath">,
  extraConfig: Record<string, unknown> = {},
): ContractCase {
  return {
    name: `systemone/${preset} preset (fixtures)`,
    providerConfig: (baseUrl) => ({ kind: "systemone", preset, apiKeyRef: "ref", baseUrl, ...extraConfig }),
    expectedModelsPath: null,
    assertAuth: expectBearer,
    expectedCostUsd: 0,
    expectedRateVersion: null,
    ...overrides,
  };
}

const SYSTEMONE_CASES: ContractCase[] = [
  {
    name: "systemone/typesafe preset",
    providerConfig: (baseUrl) => ({ kind: "systemone", preset: "typesafe", apiKeyRef: "ref", baseUrl, model: "jev-latest" }),
    expectedModel: "jev-1.13.0",
    expectedPath: "/v1/systemone",
    expectedModelsPath: "/v1/models",
    assertAuth: expectBearer,
    expectedCostUsd: 0.000515,
    expectedRateVersion: "typesafe-2026-10-09",
  },
  {
    name: "systemone generic: custom path, x-api-key auth",
    providerConfig: (baseUrl) => ({
      kind: "systemone",
      preset: "typesafe",
      apiKeyRef: "ref",
      baseUrl: `${baseUrl}/`,
      path: "/api/decide",
      authStyle: "x-api-key",
      model: "custom-decider-1",
    }),
    expectedModel: "custom-decider-1",
    expectedPath: "/api/decide",
    expectedModelsPath: "/v1/models",
    assertAuth: (headers) => {
      expect(headers["x-api-key"]).toBe(TEST_KEY);
      expect(headers.authorization).toBeUndefined();
    },
    expectedCostUsd: 0.000515,
    expectedRateVersion: "typesafe-2026-10-09",
  },
  {
    name: "systemone generic: self-hosted, no auth",
    providerConfig: (baseUrl) => ({ kind: "systemone", preset: "typesafe", baseUrl, authStyle: "none", model: "clef" }),
    expectedModel: "clef",
    expectedPath: "/v1/systemone",
    expectedModelsPath: "/v1/models",
    assertAuth: expectNoAuth,
    expectedCostUsd: 0.000515,
    expectedRateVersion: "typesafe-2026-10-09",
  },
  tierBCase("perplexity", { expectedModel: "pplx-decider-v1-27b", expectedPath: "/v1/decisions" }),
  // The synthetic reply carries no `usage.cost`, so nothing is charged; the
  // reported-cost path is covered by the docs fixture in provider-presets.spec.ts.
  tierBCase("openrouter", { expectedModel: "typesafe/jev-1.13", expectedPath: "/api/alpha/decisions" }),
  tierBCase(
    "decisions-api",
    { expectedModel: "typesafe/jev-1.13", expectedPath: "/v1/systemone" },
    { model: "typesafe/jev-1.13" },
  ),
  tierBCase("ollama", {
    expectedModel: "clef",
    expectedPath: "/v1/systemone",
    expectedModelsPath: "/api/tags",
    assertAuth: expectNoAuth,
  }),
  tierBCase(
    "ollama",
    {
      name: "systemone/ollama preset, clef-flash",
      expectedModel: "clef-flash",
      expectedPath: "/v1/systemone",
      expectedModelsPath: "/api/tags",
      assertAuth: expectNoAuth,
    },
    { model: "clef-flash" },
  ),
  tierBCase("laya", { expectedModel: "laya", expectedPath: "/v1/systemone", assertAuth: expectNoAuth }),
  tierBCase("von", { expectedModel: "von-1.3.0", expectedPath: "/v1/systemone", assertAuth: expectNoAuth }),
  tierBCase(
    "von",
    { name: "systemone/von preset, VON_API_KEY bearer", expectedModel: "von-1.3.0", expectedPath: "/v1/systemone" },
    { authStyle: "bearer" },
  ),
  tierBCase("kev", {
    expectedModel: "opper/kev-4b",
    expectedPath: "/v3/compat/v1/systemone",
    expectedCostUsd: 0.000042,
    expectedRateVersion: "kev-opper-2026-09",
  }),
];

function runtime(overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return {
    resolveSecret: async () => TEST_KEY,
    timeoutMs: 2_000,
    retry: { maxRetries: 0, backoffInitialMs: 1, backoffMaxMs: 1 },
    fetchImpl: plainHttpFetch,
    ...overrides,
  };
}

function providerFor(contract: ContractCase, baseUrl: string, overrides: Partial<ProviderRuntime> = {}): DecisionProvider {
  const config = parseVerdictConfig({ providers: { subject: contract.providerConfig(baseUrl) } });
  return buildProvider("subject", config.providers.subject, runtime(overrides));
}

const MIXED_QUESTIONS: DecisionQuestions = {
  yes_no: { type: "boolean", instructions: "Is this a test?" },
  legacy_yes_no: { type: "noul", instructions: "Is this also a test?" },
  pick: { type: "choice", instructions: "Pick one", criteria: { a: "first", b: "second" } },
  rate: { type: "score", instructions: "Rate it", criteria: ["low", "mid", "high"] },
};

/** `MIXED_QUESTIONS` minus the types the provider doesn't take (Kev documents
 * no `score`), so every case exercises its full supported surface. */
function questionsFor(provider: DecisionProvider): DecisionQuestions {
  const supported = new Set<string>(provider.capabilities.questionTypes);
  if (supported.has("boolean")) supported.add("noul");
  return Object.fromEntries(Object.entries(MIXED_QUESTIONS).filter(([, question]) => supported.has(question.type)));
}

describe.each(SYSTEMONE_CASES)("provider contract: $name", (contract) => {
  let server: MockSystemOneServer;

  beforeAll(async () => {
    server = await startMockSystemOneServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.requests.length = 0;
    server.respondWith(syntheticSystemOneReply);
  });

  it("posts the SystemOne body to the configured path with the configured auth", async () => {
    const provider = providerFor(contract, server.secureBaseUrl);
    const pipeline = new DecisionPipeline({ providers: [provider] });

    const questions = questionsFor(provider);

    const outcome = await pipeline.ask({ policy: "contract", companyId: "c1", state: { b: 2, a: 1 }, questions });

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(contract.expectedPath);
    contract.assertAuth(request.headers);
    const wireQuestions: Record<string, unknown> = {
      // `boolean` is the canonical name; SystemOne only speaks `noul`.
      yes_no: { type: "noul", instructions: "Is this a test?" },
      legacy_yes_no: { type: "noul", instructions: "Is this also a test?" },
      pick: MIXED_QUESTIONS.pick,
      rate: MIXED_QUESTIONS.rate,
    };
    expect(request.body).toEqual({
      // Canonicalized (sorted keys) before egress.
      state: '{"a":1,"b":2}',
      questions: Object.fromEntries(Object.keys(questions).map((name) => [name, wireQuestions[name]])),
      model: contract.expectedModel,
    });
    expect(provider.model).toBe(contract.expectedModel);
    expect(outcome.provider).toBe(provider);
    expect(outcome.result.answers.yes_no).toEqual({ type: "noul", noul: 0.8 });
  });

  it.runIf(contract.expectedModelsPath === null)("reports no models and skips the health ping when no models endpoint is documented", async () => {
    const provider = providerFor(contract, server.secureBaseUrl);
    await expect(provider.listModels?.()).resolves.toEqual([]);
    await expect(provider.availability()).resolves.toEqual({ ok: true, reason: "not-checked" });
    expect(server.requests).toHaveLength(0);
  });

  it.runIf(contract.expectedModelsPath !== null)("lists models from the configured models path", async () => {
    const provider = providerFor(contract, server.secureBaseUrl);
    const models = await provider.listModels?.();
    expect(models).toEqual([{ name: "mock-model", description: "synthetic", release_date: "2026-01-01" }]);
    expect(server.requests[0].path).toBe(contract.expectedModelsPath);
    contract.assertAuth(server.requests[0].headers);
    await expect(provider.availability()).resolves.toEqual({ ok: true });
  });

  it("redacts state before egress and never writes raw state to the ledger", async () => {
    const provider = providerFor(contract, server.secureBaseUrl);
    const pipeline = new DecisionPipeline({ providers: [provider], redactionPatterns: ["secret-\\d+"] });
    const db = createFakeDb();
    const writes: unknown[] = [];
    const execute = db.execute.bind(db);
    db.execute = async (sql, params) => {
      writes.push(params);
      return execute(sql, params);
    };
    const rawState = { message: "ping from secret-4242 with a distinctive raw phrase" };

    const result = await runPolicy(
      { policy: pingPolicy, state: rawState, config: parseVerdictConfig({}), companyId: "c1", issueId: "i1" },
      { client: pipeline, db, apply: { log: () => {} }, suggest: { log: () => {} } },
    );

    expect(result.outcome).toBe("observed");
    const sent = server.requests[0].body as { state: string };
    expect(sent.state).not.toContain("secret-4242");
    expect(sent.state).toContain("[REDACTED]");
    const ledger = JSON.stringify(writes);
    expect(ledger).not.toContain("secret-4242");
    expect(ledger).not.toContain("distinctive raw phrase");
    expect(ledger).toContain('"subject"');
  });

  it("refuses a question set over the provider's caps before any call", async () => {
    const provider = providerFor(contract, server.secureBaseUrl);
    const pipeline = new DecisionPipeline({ providers: [provider] });
    const tooManyOptions = Object.fromEntries(Array.from({ length: provider.capabilities.maxChoiceOptions + 1 }, (_, i) => [`o${i}`, null]));
    const tooManyLevels = Array.from({ length: provider.capabilities.maxScoreLevels + 1 }, (_, i) => `level ${i}`);

    await expect(
      pipeline.ask({ policy: "contract", companyId: "c1", state: "s", questions: { q: { type: "choice", criteria: tooManyOptions } } }),
    ).rejects.toMatchObject({ reason: "capability-max-options" });
    await expect(
      pipeline.ask({
        policy: "contract",
        companyId: "c1",
        state: "s",
        questions: { q: { type: "score", criteria: tooManyLevels as [string, string, ...string[]] } },
      }),
    ).rejects.toMatchObject({
      reason: provider.capabilities.questionTypes.includes("score") ? "capability-max-score-levels" : "capability-question-type",
    });
    await expect(
      pipeline.ask({
        policy: "contract",
        companyId: "c1",
        state: "x".repeat(provider.capabilities.maxRequestBytes + 1),
        questions: questionsFor(provider),
      }),
    ).resolves.toBeDefined(); // state is truncated first, so an oversized raw state never trips the byte cap
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    { status: 401, code: "auth-failed" },
    { status: 403, code: "permission-denied" },
    { status: 429, code: "rate-limited" },
    { status: 500, code: "provider-error-500" },
    // SystemOne has no refusal answer: a server that won't answer returns an
    // error status, which must surface as an error and never as an answer.
    { status: 422, code: "provider-error-422" },
  ])("maps HTTP $status to $code", async ({ status, code }) => {
    server.respondWith(() => ({ status, body: { error: { message: "nope" } } }));
    const pipeline = new DecisionPipeline({ providers: [providerFor(contract, server.secureBaseUrl)] });

    const error = await pipeline.ask({ policy: "contract", companyId: "c1", state: "s", questions: { q: { type: "boolean", instructions: "q?" } } }).catch((e) => e);
    expect(classifyError(error)).toBe(code);
  });

  it("maps a malformed body and a model-echo mismatch to validation-failed", async () => {
    const pipeline = new DecisionPipeline({ providers: [providerFor(contract, server.secureBaseUrl)] });
    // SDK 0.7.0 refuses a question with neither instructions nor criteria
    // before sending, so the question carries instructions.
    const ask = () =>
      pipeline.ask({ policy: "contract", companyId: "c1", state: "s", questions: { q: { type: "boolean", instructions: "q?" } } });

    server.respondWith(() => ({ body: { model: contract.expectedModel, answers: { q: { type: "noul", noul: 7 } }, usage: { input_tokens: 1, output_tokens: 1 } } }));
    expect(classifyError(await ask().catch((e) => e))).toBe("validation-failed");

    server.respondWith(() => ({ body: { model: "someone-else", answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } } }));
    expect(classifyError(await ask().catch((e) => e))).toBe("validation-failed");
  });

  const takesScore = providerFor(contract, "https://127.0.0.1").capabilities.questionTypes.includes("score");
  it.runIf(takesScore)("derives a missing choice/score confidence with the canonical formulas and records the source", async () => {
    const pipeline = new DecisionPipeline({ providers: [providerFor(contract, server.secureBaseUrl)] });
    const native = await pipeline.ask({ policy: "contract", companyId: "c1", state: "native", questions: MIXED_QUESTIONS });
    expect(native.confidenceSource).toBe("native");
    expect(native.result.answers.pick).toMatchObject({ confidence: 0.9 });

    server.respondWith((request) => {
      const reply = syntheticSystemOneReply(request);
      const body = reply.body as { answers: Record<string, Record<string, unknown>> };
      for (const answer of Object.values(body.answers)) delete answer.confidence;
      return reply;
    });
    const derived = await pipeline.ask({ policy: "contract", companyId: "c1", state: "derived", questions: MIXED_QUESTIONS });
    // pick: 0.9 of two options. rate: 0.9 on level 0, 0.05 on each of 1 and
    // 2, so the spread from level 0 is 0.15 against MAD_unif 2/3.
    expect(derived.result.answers.pick).toMatchObject({ confidence: expect.closeTo(0.8, 12) });
    expect(derived.result.answers.rate).toMatchObject({ confidence: expect.closeTo(1 - 0.15 / (2 / 3), 12) });
    expect(derived.confidenceSource).toBe("derived");
    expect(answeredByFields(derived).confidenceSource).toBe("derived");

    // A cache hit keeps the source of the answer it replays.
    const cachedPipeline = new DecisionPipeline({ providers: [providerFor(contract, server.secureBaseUrl)], cache: createInMemoryVerdictCache() });
    await cachedPipeline.ask({ policy: "contract", companyId: "c1", state: "derived", questions: MIXED_QUESTIONS });
    const hit = await cachedPipeline.ask({ policy: "contract", companyId: "c1", state: "derived", questions: MIXED_QUESTIONS });
    expect(hit).toMatchObject({ cached: true, confidenceSource: "derived" });
  });

  it("maps a slow server to timeout", async () => {
    server.respondWith((request) => ({ ...syntheticSystemOneReply(request), delayMs: 500 }));
    const pipeline = new DecisionPipeline({ providers: [providerFor(contract, server.secureBaseUrl, { timeoutMs: 50 })] });

    const error = await pipeline.ask({ policy: "contract", companyId: "c1", state: "s", questions: { q: { type: "boolean", instructions: "q?" } } }).catch((e) => e);
    expect(classifyError(error)).toBe("timeout");
  });

  it("estimates cost from the preset's rate card and records its version", async () => {
    const pipeline = new DecisionPipeline({ providers: [providerFor(contract, server.secureBaseUrl)] });

    const outcome = await pipeline.ask({ policy: "contract", companyId: "c1", state: "s", questions: { q: { type: "boolean", instructions: "q?" } } });

    // 1000 input + 10 output tokens: $0.5 / $1.5 per 1M for TypeSafe, input-only
    // $0.042 per 1M for Kev, nothing for presets without a published price.
    expect(outcome.costUsd).toBeCloseTo(contract.expectedCostUsd, 9);
    expect(outcome.rateVersion).toBe(contract.expectedRateVersion);
    expect(outcome.hostInvocationId).toBeNull();
  });
});

describe("provider contract: core (fake host SDK)", () => {
  function fakeHost(overrides: Partial<HostDecisionCapability> = {}) {
    const calls: Array<{ input: unknown }> = [];
    const decisions: HostDecisionCapability = {
      async decide(input) {
        calls.push({ input });
        return {
          model: "host-picked-model",
          answers: { yes_no: { type: "noul", noul: 0.7 } },
          usage: { input_tokens: 5, output_tokens: 1 },
          invocationId: "inv_123",
        };
      },
      ...overrides,
    };
    return { host: { decisions }, calls };
  }

  it("is unavailable, and fails as provider-unavailable, on a host without the capability", async () => {
    const provider = new CoreProvider("core", { issues: {} });
    expect(provider.detected).toBe(false);
    await expect(provider.availability()).resolves.toEqual({ ok: false, reason: CORE_UNAVAILABLE_REASON });

    const pipeline = new DecisionPipeline({ providers: [provider] });
    const error = await pipeline.ask({ policy: "p", companyId: "c1", state: "s", questions: { yes_no: { type: "boolean" } } }).catch((e) => e);
    expect(classifyError(error)).toBe("provider-unavailable");
  });

  it("calls the host with SystemOne-shaped questions and records no cost, no rate card, and the host invocation id", async () => {
    const { host, calls } = fakeHost();
    const provider = new CoreProvider("core", host);
    expect(provider.detected).toBe(true);
    expect((provider as DecisionProvider).estimateCostUsd).toBeUndefined();
    await expect(provider.availability()).resolves.toEqual({ ok: true });

    const budgetCalls: unknown[] = [];
    const pipeline = new DecisionPipeline({
      providers: [provider],
      dailyTokenBudget: 1,
      budgetStore: {
        get: async () => {
          budgetCalls.push("get");
          return { tokens: 999, costUsd: 9 };
        },
        add: async () => {
          budgetCalls.push("add");
          return { tokens: 0, costUsd: 0 };
        },
      },
    });
    const outcome = await pipeline.ask({ policy: "p", companyId: "c1", state: "s", questions: { yes_no: { type: "boolean" } } });

    expect(calls[0].input).toEqual({ state: "s", questions: { yes_no: { type: "noul" } } });
    expect(outcome.result.model).toBe("host-picked-model");
    expect(outcome.costUsd).toBeNull();
    expect(outcome.rateVersion).toBeNull();
    expect(outcome.hostInvocationId).toBe("inv_123");
    // The plugin's budget only governs plugin-billed providers.
    expect(budgetCalls).toEqual([]);
  });

  it("enforces core's 20-question / 20-option / 32 KB caps", async () => {
    const { host, calls } = fakeHost();
    // State is truncated before the byte check; lift the truncation limit so a
    // 38 KB state reaches it intact.
    const pipeline = new DecisionPipeline({ providers: [new CoreProvider("core", host)], maxStateChars: 40_000 });
    const ask = (questions: DecisionQuestions, state = "s") => pipeline.ask({ policy: "p", companyId: "c1", state, questions });

    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, { type: "boolean" as const }]));
    await expect(ask(many)).rejects.toBeInstanceOf(CapabilityError);
    await expect(ask(many)).rejects.toMatchObject({ reason: "capability-max-questions" });

    const options = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`o${i}`, null]));
    await expect(ask({ q: { type: "choice", criteria: options } })).rejects.toMatchObject({ reason: "capability-max-options" });

    await expect(ask({ q: { type: "boolean" } }, "x".repeat(19_000) + "y".repeat(19_000))).rejects.toMatchObject({
      reason: "capability-max-request-bytes",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed host answer as validation-failed", async () => {
    const { host } = fakeHost({ decide: async () => ({ model: "m", answers: { yes_no: { type: "noul", noul: 2 } } }) });
    const pipeline = new DecisionPipeline({ providers: [new CoreProvider("core", host)] });
    const error = await pipeline.ask({ policy: "p", companyId: "c1", state: "s", questions: { yes_no: { type: "boolean" } } }).catch((e) => e);
    expect(classifyError(error)).toBe("validation-failed");
  });
});
