import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseVerdictConfig } from "../src/config.js";
import { DecisionPipeline } from "../src/decision/pipeline.js";
import type { DecisionProvider } from "../src/decision/provider.js";
import { allowlistedFetch, buildProvider, egressAllowlist, type ProviderRuntime } from "../src/decision/registry.js";
import { classifyError, errorClassOf } from "../src/decision/errors.js";
import { runPolicy } from "../src/policies/run.js";
import { pingPolicy } from "../src/policies/ping.js";
import type { DecisionQuestions } from "../src/decision/types.js";
import { createFakeDb } from "./helpers/fake-db.js";
import { plainHttpFetch, startMockSystemOneServer, type MockHandler, type MockSystemOneServer } from "./helpers/mock-systemone-server.js";
import { syntheticOpenAiReply, syntheticWorkersAiReply } from "./helpers/mock-tier-a.js";

/**
 * L1 contract suite for the Tier A adapters with their own wire shape
 * (plan 2.3b): Cloudflare Workers AI and OpenAI Decisions, each against an
 * in-process mock server. Same assertions as the SystemOne suite (path, auth,
 * body, caps, redaction, error mapping, timeout, cost) plus each adapter's
 * envelope or translation.
 */

const TEST_KEY = "sk-contract-test";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const MIXED_QUESTIONS: DecisionQuestions = {
  yes_no: { type: "boolean", instructions: "Is this a test?", criteria: { true: "it is a test", false: "it is real" } },
  legacy_yes_no: { type: "noul", instructions: "Is this also a test?" },
  pick: { type: "choice", instructions: "Pick one", criteria: { a: "first", b: null, c: { detail: "third" } } },
  rate: { type: "score", instructions: "Rate it", criteria: ["low", "mid", "high"] },
};

function runtime(overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return {
    resolveSecret: async () => TEST_KEY,
    timeoutMs: 2_000,
    retry: { maxRetries: 0, backoffInitialMs: 1, backoffMaxMs: 1 },
    fetchImpl: plainHttpFetch,
    ...overrides,
  };
}

function providerFrom(raw: Record<string, unknown>, overrides: Partial<ProviderRuntime> = {}): DecisionProvider {
  const config = parseVerdictConfig({ providers: { subject: raw } });
  return buildProvider("subject", config.providers.subject, runtime(overrides));
}

interface TierACase {
  name: string;
  reply: MockHandler;
  providerConfig: (baseUrl: string) => Record<string, unknown>;
  expectedModel: string;
  expectedPath: string;
  expectedModelsPath: string;
  /** The body the adapter must send for `MIXED_QUESTIONS` and state `{b:2,a:1}`. */
  expectedBody: unknown;
  expectedCostUsd: number;
  expectedRateVersion: string;
  /** Wraps a SystemOne-shaped `{model, answers, usage}` in the provider's reply shape. */
  wrapReply: (result: unknown) => unknown;
}

const CASES: TierACase[] = [
  {
    name: "cloudflare (Workers AI, clef-flash)",
    reply: syntheticWorkersAiReply,
    providerConfig: (baseUrl) => ({ kind: "cloudflare", accountId: ACCOUNT_ID, apiKeyRef: "ref", model: "clef-flash", baseUrl }),
    expectedModel: "clef-flash",
    expectedPath: `/accounts/${ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash`,
    expectedModelsPath: `/accounts/${ACCOUNT_ID}/ai/models/search?search=clef`,
    expectedBody: {
      model: "clef-flash",
      state: '{"a":1,"b":2}',
      questions: {
        yes_no: { type: "noul", instructions: "Is this a test?", criteria: { true: "it is a test", false: "it is real" } },
        legacy_yes_no: { type: "noul", instructions: "Is this also a test?" },
        pick: MIXED_QUESTIONS.pick,
        rate: MIXED_QUESTIONS.rate,
      },
    },
    // 1000 input tokens at $0.038 per 1M; decision models bill no output.
    expectedCostUsd: 0.000038,
    expectedRateVersion: "cloudflare-2026-11-11",
    wrapReply: (result) => ({ result, success: true, errors: [], messages: [] }),
  },
  {
    name: "openai (Decisions API, gpt-6-luna)",
    reply: syntheticOpenAiReply,
    providerConfig: (baseUrl) => ({ kind: "openai", apiKeyRef: "ref", baseUrl: `${baseUrl}/v1` }),
    expectedModel: "gpt-6-luna",
    expectedPath: "/v1/decisions",
    expectedModelsPath: "/v1/models/gpt-6-luna",
    expectedBody: {
      model: "gpt-6-luna",
      input: '{"a":1,"b":2}',
      // Insertion order is kept: the API is order sensitive.
      questions: [
        { name: "yes_no", type: "predicate", instructions: "Is this a test?\nTrue means: it is a test\nFalse means: it is real" },
        { name: "legacy_yes_no", type: "predicate", instructions: "Is this also a test?" },
        {
          name: "pick",
          type: "choice",
          instructions: "Pick one",
          choices: [{ value: "a", description: "first" }, { value: "b" }, { value: "c", description: '{"detail":"third"}' }],
        },
        {
          name: "rate",
          type: "score",
          instructions: "Rate it",
          levels: [
            { label: "0", description: "low" },
            { label: "1", description: "mid" },
            { label: "2", description: "high" },
          ],
        },
      ],
    },
    expectedCostUsd: 0.0001,
    expectedRateVersion: "openai-2026-11-11",
    wrapReply: (result) => {
      const { model, answers, usage } = result as { model: string; answers: Record<string, { noul: number }>; usage: unknown };
      return {
        model,
        answers: Object.entries(answers).map(([name, answer]) => ({ type: "predicate", name, probability: answer.noul })),
        usage,
      };
    },
  },
];

describe.each(CASES)("provider contract: $name", (contract) => {
  let server: MockSystemOneServer;

  beforeAll(async () => {
    server = await startMockSystemOneServer(contract.reply);
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.requests.length = 0;
    server.respondWith(contract.reply);
  });

  const provider = (overrides: Partial<ProviderRuntime> = {}) => providerFrom(contract.providerConfig(server.secureBaseUrl), overrides);
  const ask = (p: DecisionProvider, questions: DecisionQuestions = MIXED_QUESTIONS, state: unknown = "s") =>
    new DecisionPipeline({ providers: [p] }).ask({ policy: "contract", companyId: "c1", state, questions });

  it("posts the provider's body shape to its path with bearer auth, and maps answers back to SystemOne shape", async () => {
    const subject = provider();
    const outcome = await ask(subject, MIXED_QUESTIONS, { b: 2, a: 1 });

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(contract.expectedPath);
    expect(request.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(request.body).toEqual(contract.expectedBody);
    expect(subject.model).toBe(contract.expectedModel);
    expect(subject.verification).toBe("live");
    expect(outcome.result.model).toBe(contract.expectedModel);
    expect(outcome.result.answers.yes_no).toEqual({ type: "noul", noul: 0.8 });
    expect(outcome.result.answers.pick).toMatchObject({ type: "choice", choice: "a", confidence: 0.9 });
    expect(outcome.result.answers.rate).toMatchObject({
      type: "score",
      legend: { "0": expect.any(String), "1": expect.any(String), "2": expect.any(String) },
    });
  });

  it("lists models and reports availability from the provider's models path", async () => {
    const subject = provider();
    const models = (await subject.listModels?.()) ?? [];
    expect(models.map((model) => model.name)).toContain(contract.expectedModel);
    expect(server.requests[0].method).toBe("GET");
    expect(server.requests[0].path).toBe(contract.expectedModelsPath);
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    await expect(subject.availability()).resolves.toEqual({ ok: true });
  });

  it("redacts state before egress and never writes raw state to the ledger", async () => {
    const db = createFakeDb();
    const writes: unknown[] = [];
    const execute = db.execute.bind(db);
    db.execute = async (sql, params) => {
      writes.push(params);
      return execute(sql, params);
    };
    const pipeline = new DecisionPipeline({ providers: [provider()], redactionPatterns: ["secret-\\d+"] });

    const result = await runPolicy(
      {
        policy: pingPolicy,
        state: { message: "ping from secret-4242 with a distinctive raw phrase" },
        config: parseVerdictConfig({}),
        companyId: "c1",
        issueId: "i1",
      },
      { client: pipeline, db, apply: { log: () => {} }, suggest: { log: () => {} } },
    );

    expect(result.outcome).toBe("observed");
    // State is redacted. Question text is not (the `ping` policy quotes the
    // message into its question): a known pre-existing gap, same on every
    // provider, tracked for the G6 security review.
    const body = server.requests[0].body as { state?: string; input?: string };
    const sent = body.state ?? body.input ?? "";
    expect(sent).not.toContain("secret-4242");
    expect(sent).toContain("[REDACTED]");
    const ledger = JSON.stringify(writes);
    expect(ledger).not.toContain("secret-4242");
    expect(ledger).not.toContain("distinctive raw phrase");
  });

  it("refuses a question set over the adapter's caps before any call", async () => {
    const subject = provider();
    const caps = subject.capabilities;
    const tooMany = Object.fromEntries(Array.from({ length: caps.maxQuestions + 1 }, (_, i) => [`q${i}`, { type: "boolean" as const }]));
    const tooManyOptions = Object.fromEntries(Array.from({ length: caps.maxChoiceOptions + 1 }, (_, i) => [`o${i}`, null]));
    const tooManyLevels = Array.from({ length: caps.maxScoreLevels + 1 }, (_, i) => `level ${i}`) as [string, string, ...string[]];

    await expect(ask(subject, tooMany)).rejects.toMatchObject({ reason: "capability-max-questions" });
    await expect(ask(subject, { q: { type: "choice", criteria: tooManyOptions } })).rejects.toMatchObject({
      reason: "capability-max-options",
    });
    await expect(ask(subject, { q: { type: "score", criteria: tooManyLevels } })).rejects.toMatchObject({
      reason: "capability-max-score-levels",
    });
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    { status: 401, code: "auth-failed", errorClass: "auth_config" },
    { status: 403, code: "permission-denied", errorClass: "auth_config" },
    { status: 429, code: "rate-limited", errorClass: "rate_limited" },
    { status: 500, code: "provider-error-500", errorClass: "http_5xx" },
    { status: 422, code: "provider-error-422", errorClass: "invalid_request" },
  ])("maps HTTP $status to $code ($errorClass), without the provider's error text", async ({ status, code, errorClass }) => {
    server.respondWith(() => ({ status, body: { error: { message: "echo of secret state" }, errors: [{ message: "echo" }] } }));
    const error = await ask(provider()).catch((e: unknown) => e);
    expect(classifyError(error)).toBe(code);
    expect(errorClassOf(error)).toBe(errorClass);
    expect((error as Error).message).not.toContain("secret state");
  });

  it("retries a 503 and honors Retry-After, then succeeds", async () => {
    let calls = 0;
    server.respondWith((request) => {
      calls += 1;
      return calls === 1 ? { status: 503, headers: { "retry-after": "0" }, body: {} } : contract.reply(request);
    });
    const outcome = await ask(provider({ retry: { maxRetries: 2, backoffInitialMs: 1, backoffMaxMs: 5 } }));
    expect(calls).toBe(2);
    expect(outcome.result.model).toBe(contract.expectedModel);
  });

  it("maps a malformed body and a model-echo mismatch to validation-failed", async () => {
    server.respondWith(() => ({ body: { nonsense: true } }));
    expect(classifyError(await ask(provider()).catch((e: unknown) => e))).toBe("validation-failed");

    server.respondWith(() => ({
      body: contract.wrapReply({
        model: "someone-else",
        answers: { q: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    }));
    const mismatch = await ask(provider(), { q: { type: "boolean", instructions: "q?" } }).catch((e: unknown) => e);
    expect(classifyError(mismatch)).toBe("validation-failed");
    expect(errorClassOf(mismatch)).toBe("invalid_output");
  });

  it("maps a slow server to timeout", async () => {
    server.respondWith((request) => ({ ...contract.reply(request), delayMs: 500 }));
    const error = await ask(provider({ timeoutMs: 50 })).catch((e: unknown) => e);
    expect(classifyError(error)).toBe("timeout");
  });

  it("estimates cost from its rate card and records the rate version", async () => {
    const outcome = await ask(provider());
    expect(outcome.costUsd).toBeCloseTo(contract.expectedCostUsd, 12);
    expect(outcome.rateVersion).toBe(contract.expectedRateVersion);
  });

  it("cannot reach a host outside the egress allowlist", async () => {
    const raw = contract.providerConfig(server.secureBaseUrl);
    const config = parseVerdictConfig({ providers: { subject: raw } });
    expect([...egressAllowlist(config)]).toEqual([new URL(server.secureBaseUrl).origin]);

    const elsewhere = allowlistedFetch(new Set(["https://api.typesafe.ai"]), (input, init) => fetch(input, init));
    const error = await ask(providerFrom(raw, { fetchImpl: elsewhere })).catch((e: unknown) => e);
    expect(classifyError(error)).toBe("egress-blocked");
    expect(errorClassOf(error)).toBe("auth_config");
    expect(server.requests).toHaveLength(0);
  });
});

describe("cloudflare adapter specifics", () => {
  let server: MockSystemOneServer;
  beforeAll(async () => {
    server = await startMockSystemOneServer(syntheticWorkersAiReply);
  });
  afterAll(async () => {
    await server.close();
  });

  it("treats an envelope with success: false as invalid output", async () => {
    server.respondWith(() => ({ body: { success: false, result: null, errors: [{ code: 3030, message: "nope" }] } }));
    const subject = providerFrom({ kind: "cloudflare", accountId: ACCOUNT_ID, apiKeyRef: "ref", baseUrl: server.secureBaseUrl });
    const error = await new DecisionPipeline({ providers: [subject] })
      .ask({ policy: "p", companyId: "c1", state: "s", questions: { q: { type: "boolean", instructions: "q?" } } })
      .catch((e: unknown) => e);
    expect(classifyError(error)).toBe("validation-failed");
  });

  it("reports a model missing from the catalog as unavailable", async () => {
    server.respondWith(() => ({ body: { success: true, result: [{ name: "@cf/cloudflare/clef" }] } }));
    const subject = providerFrom({ kind: "cloudflare", accountId: ACCOUNT_ID, apiKeyRef: "ref", model: "clef-flash", baseUrl: server.secureBaseUrl });
    await expect(subject.availability()).resolves.toEqual({ ok: false, reason: "model-not-listed" });
  });

  it("declares Clef's caps: 64 questions, 26 options, smaller context for clef-flash, no images", () => {
    const clef = providerFrom({ kind: "cloudflare", accountId: ACCOUNT_ID, model: "clef" });
    const flash = providerFrom({ kind: "cloudflare", accountId: ACCOUNT_ID, model: "clef-flash" });
    expect(clef.capabilities).toMatchObject({ maxQuestions: 64, maxChoiceOptions: 26, images: false, billing: "plugin" });
    expect(flash.capabilities.maxRequestBytes).toBeLessThan(clef.capabilities.maxRequestBytes);
  });
});

describe("openai adapter specifics", () => {
  let server: MockSystemOneServer;
  beforeAll(async () => {
    server = await startMockSystemOneServer(syntheticOpenAiReply);
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.requests.length = 0;
    server.respondWith(syntheticOpenAiReply);
  });
  const luna = () => providerFrom({ kind: "openai", apiKeyRef: "ref", baseUrl: `${server.secureBaseUrl}/v1` });

  it("turns a refusal into DecisionRefusalError, never an answer, and does not fall back", async () => {
    server.respondWith(() => ({
      body: {
        model: "gpt-6-luna",
        answers: [
          { type: "predicate", name: "ok", probability: 0.4 },
          { type: "refusal", name: "unsafe" },
        ],
        usage: { input_tokens: 17, output_tokens: 0 },
      },
    }));
    const fallback = { ...luna(), id: "fallback", decide: vi.fn() } as unknown as DecisionProvider;
    const error = await new DecisionPipeline({ providers: [luna(), fallback] })
      .ask({
        policy: "p",
        companyId: "c1",
        state: "s",
        questions: { ok: { type: "boolean", instructions: "ok?" }, unsafe: { type: "boolean", instructions: "unsafe?" } },
      })
      .catch((e: unknown) => e);

    expect(classifyError(error)).toBe("refused");
    expect(errorClassOf(error)).toBe("refusal");
    expect((error as { questions: string[] }).questions).toEqual(["unsafe"]);
    expect(fallback.decide).not.toHaveBeenCalled();
  });

  it("rejects an answer for an unknown question and a missing answer", async () => {
    const ask = () =>
      new DecisionPipeline({ providers: [luna()] }).ask({
        policy: "p",
        companyId: "c1",
        state: "s",
        questions: { a: { type: "boolean", instructions: "a?" }, b: { type: "boolean", instructions: "b?" } },
      });
    server.respondWith(() => ({
      body: { model: "gpt-6-luna", answers: [{ type: "predicate", name: "a", probability: 0.4 }], usage: { input_tokens: 1, output_tokens: 0 } },
    }));
    expect(classifyError(await ask().catch((e: unknown) => e))).toBe("validation-failed");

    server.respondWith(() => ({
      body: {
        model: "gpt-6-luna",
        answers: [
          { type: "predicate", name: "a", probability: 0.4 },
          { type: "predicate", name: "b", probability: 0.4 },
          { type: "predicate", name: "zzz", probability: 0.4 },
        ],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }));
    expect(classifyError(await ask().catch((e: unknown) => e))).toBe("validation-failed");
  });

  it("rescales two-decimal probabilities that don't sum to 1, keeping the argmax", async () => {
    const options = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`o${i}`, null]));
    server.respondWith(() => ({
      body: {
        model: "gpt-6-luna",
        answers: [
          {
            type: "choice",
            name: "pick",
            choice: "o0",
            // 0.5 + 29 * 0.02 = 1.08: outside the canonical schema's tolerance.
            probabilities: Object.keys(options).map((value, i) => ({ value, probability: i === 0 ? 0.5 : 0.02 })),
            confidence: 0.4,
          },
        ],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }));
    const outcome = await new DecisionPipeline({ providers: [luna()] }).ask({
      policy: "p",
      companyId: "c1",
      state: "s",
      questions: { pick: { type: "choice", instructions: "pick", criteria: options } },
    });
    const pick = outcome.result.answers.pick as { choice: string; probabilities: Record<string, number> };
    expect(pick.choice).toBe("o0");
    expect(Object.values(pick.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("asks a question without instructions by its name, since the API requires them", async () => {
    await new DecisionPipeline({ providers: [luna()] }).ask({
      policy: "p",
      companyId: "c1",
      state: "s",
      questions: { is_bug: { type: "boolean" } },
    });
    expect((server.requests[0].body as { questions: unknown[] }).questions).toEqual([
      { name: "is_bug", type: "predicate", instructions: "is_bug" },
    ]);
  });

  // The prompt cache keys on a shared prefix and the model is order
  // sensitive: `model`, then `input`, then the questions in the policy's
  // insertion order (deliberately not alphabetical here), byte for byte.
  it("serializes the request in a stable, cache-friendly order", async () => {
    await new DecisionPipeline({ providers: [luna()] }).ask({
      policy: "p",
      companyId: "c1",
      state: { b: 2, a: 1 },
      questions: {
        zeta: { type: "score", instructions: "Rate it", criteria: ["low", "high"] },
        alpha: { type: "choice", instructions: "Pick one", criteria: { y: null, x: "ex" } },
        mid: { type: "boolean", instructions: "Is it?" },
      },
    });
    expect(server.requests[0].rawBody).toBe(
      '{"model":"gpt-6-luna","input":"{\\"a\\":1,\\"b\\":2}","questions":[' +
        '{"name":"zeta","type":"score","instructions":"Rate it","levels":[{"label":"0","description":"low"},{"label":"1","description":"high"}]},' +
        '{"name":"alpha","type":"choice","instructions":"Pick one","choices":[{"value":"y"},{"value":"x","description":"ex"}]},' +
        '{"name":"mid","type":"predicate","instructions":"Is it?"}]}',
    );
  });
});

describe("providers config: per-kind validation", () => {
  it("accepts all three Tier A kinds side by side", () => {
    const config = parseVerdictConfig({
      providers: {
        typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "ref" },
        "cf-clef": { kind: "cloudflare", accountId: ACCOUNT_ID, apiKeyRef: "ref", model: "clef" },
        luna: { kind: "openai", apiKeyRef: "ref" },
      },
      defaultProvider: "typesafe",
    });
    expect(Object.keys(config.providers)).toEqual(["typesafe", "cf-clef", "luna"]);
    expect([...egressAllowlist(config)].sort()).toEqual([
      "https://api.cloudflare.com",
      "https://api.openai.com",
      "https://api.typesafe.ai",
    ]);
  });

  it.each([
    { name: "cloudflare without accountId", raw: { kind: "cloudflare", apiKeyRef: "ref" } },
    { name: "cloudflare with a malformed accountId", raw: { kind: "cloudflare", accountId: "not-an-id" } },
    { name: "cloudflare with an unknown model", raw: { kind: "cloudflare", accountId: ACCOUNT_ID, model: "llama" } },
    { name: "openai with a systemone-only field", raw: { kind: "openai", preset: "typesafe" } },
    { name: "an unknown kind", raw: { kind: "perplexity" } },
  ])("rejects $name", ({ raw }) => {
    expect(() => parseVerdictConfig({ providers: { subject: raw } })).toThrow();
  });

  it("keeps the egress allowlist to the TypeSafe host for a TypeSafe-only (legacy) config", () => {
    expect([...egressAllowlist(parseVerdictConfig({ apiKeyRef: "ref" }))]).toEqual(["https://api.typesafe.ai"]);
  });
});
