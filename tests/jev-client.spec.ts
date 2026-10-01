import { describe, expect, it, vi } from "vitest";
import { JevClient, JevValidationError } from "../src/jev/client.js";
import { BudgetExceededError, createInMemoryBudgetStore } from "../src/jev/budget.js";
import { createInMemoryJevCache } from "../src/jev/cache.js";
import type { Fetch } from "@typesafe-ai/sdk";

const PING_QUESTIONS = { pong: { type: "noul" as const, instructions: "Is this a ping?" } };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function fakeSuccessResult(overrides: Partial<{ model: string }> = {}) {
  return {
    model: overrides.model ?? "jev-1.13.0",
    answers: { pong: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe("JevClient", () => {
  it("validates and returns a well-formed response", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(fakeSuccessResult()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const outcome = await client.ask({
      policy: "ping",
      companyId: "company_1",
      state: "hello",
      questions: PING_QUESTIONS,
    });

    expect(outcome.result.answers.pong).toEqual({ type: "noul", noul: 0.9 });
    expect(outcome.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a response whose model echo does not match the requested model", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(fakeSuccessResult({ model: "some-other-model" })));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl, model: "jev-1.13.0" });

    await expect(
      client.ask({ policy: "ping", companyId: "company_1", state: "hello", questions: PING_QUESTIONS }),
    ).rejects.toThrow(JevValidationError);
  });

  it("rejects a choice answer whose probabilities don't sum to 1", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          pong: { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.3 } },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    await expect(
      client.ask({ policy: "ping", companyId: "company_1", state: "hello", questions: PING_QUESTIONS }),
    ).rejects.toThrow(JevValidationError);
  });

  it("retries a 429 with Retry-After and succeeds on the next attempt", async () => {
    const fetchImpl = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(jsonResponse(fakeSuccessResult()));
    const client = new JevClient({
      resolveApiKey: async () => "test-key",
      fetchImpl,
      retry: { maxRetries: 1, backoffInitialMs: 1, backoffMaxMs: 1 },
    });

    const outcome = await client.ask({
      policy: "ping",
      companyId: "company_1",
      state: "hello",
      questions: PING_QUESTIONS,
    });

    expect(outcome.result.answers.pong).toEqual({ type: "noul", noul: 0.9 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves a repeated ask from cache without calling the provider again", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(fakeSuccessResult()));
    const cache = createInMemoryJevCache();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl, cache });
    const input = { policy: "ping", companyId: "company_1", state: "hello", questions: PING_QUESTIONS };

    const first = await client.ask(input);
    const second = await client.ask(input);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("redacts state before it reaches the provider", async () => {
    let sentBody: unknown;
    const fetchImpl = vi.fn<Fetch>(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return jsonResponse(fakeSuccessResult());
    });
    const client = new JevClient({
      resolveApiKey: async () => "test-key",
      fetchImpl,
      redactionPatterns: ["secret-\\d+"],
    });

    await client.ask({
      policy: "ping",
      companyId: "company_1",
      state: "call me about secret-42 please",
      questions: PING_QUESTIONS,
    });

    expect((sentBody as { state: string }).state).toBe("call me about [REDACTED] please");
  });

  it("fails closed when the company's daily token budget is already exhausted", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(fakeSuccessResult()));
    const budgetStore = createInMemoryBudgetStore();
    await budgetStore.add("company_1", new Date().toISOString().slice(0, 10), { tokens: 10, costUsd: 0.01 });
    const client = new JevClient({
      resolveApiKey: async () => "test-key",
      fetchImpl,
      budgetStore,
      dailyTokenBudget: 10,
    });

    await expect(
      client.ask({ policy: "ping", companyId: "company_1", state: "hello", questions: PING_QUESTIONS }),
    ).rejects.toThrow(BudgetExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
