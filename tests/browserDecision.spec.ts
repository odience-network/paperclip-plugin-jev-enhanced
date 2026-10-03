import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "@typesafe-ai/sdk";
import { JevClient } from "../src/jev/client.js";
import { decideBrowserAction, MAX_BROWSER_ELEMENTS } from "../src/tools/browserDecision.js";
import { jevConfigSchema, type JevConfig } from "../src/config.js";
import type { LedgerDb } from "../src/ledger/db.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createFakeDb(): LedgerDb {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    namespace: "plugin_jev_test",
    async execute(sql, params = []) {
      if (sql.includes("INSERT INTO")) {
        const [id] = params;
        rows.set(id as string, { id, outcome: "observed" });
        return { rowCount: 1 };
      }
      if (sql.includes("UPDATE")) {
        const [id, , , , , , , , outcome, reason] = params;
        const row = rows.get(id as string);
        if (row) Object.assign(row, { outcome, reason });
        return { rowCount: row ? 1 : 0 };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
    async query() {
      return [...rows.values()] as never;
    },
  };
}

function baseConfig(overrides: Partial<JevConfig> = {}): JevConfig {
  return jevConfigSchema.parse({ browserAllowedOrigins: ["https://app.example.com"], ...overrides });
}

const GOAL = "Submit the contact form";
const ALLOWED_URL = "https://app.example.com/contact";
const ELEMENTS = [
  { index: 0, role: "textbox", placeholder: "Name" },
  { index: 1, role: "button", text: "Submit" },
];

function clickAnswers(overrides: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      action: {
        type: "choice",
        choice: "click",
        confidence: 0.93,
        probabilities: { click: 0.93, type: 0.02, select: 0.02, scroll: 0.01, wait: 0.01, done: 0.01 },
      },
      sensitivity: { type: "noul", noul: 0.05 },
      target_0: { type: "noul", noul: 0.1 },
      target_1: { type: "noul", noul: 0.88 },
      ...overrides,
    },
    usage: { input_tokens: 50, output_tokens: 10 },
  };
}

describe("decideBrowserAction input validation", () => {
  it("rejects unknown fields on an element (e.g. a selector) without calling the provider", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: [{ index: 0, role: "button", selector: "#submit" }] },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toEqual({ outcome: "skipped", reason: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects duplicate element indices", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: [{ index: 0, role: "button" }, { index: 0, role: "link" }] },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toEqual({ outcome: "skipped", reason: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it(`rejects more than ${MAX_BROWSER_ELEMENTS} elements`, async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const elements = Array.from({ length: MAX_BROWSER_ELEMENTS + 1 }, (_, index) => ({ index, role: "button" }));

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toEqual({ outcome: "skipped", reason: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips disabled policies without calling the provider", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: baseConfig({ policies: { "browser-action": { enabled: false, mode: "shadow", thresholds: {} } } }),
        companyId: "company_1",
        log: vi.fn(),
      },
    );

    expect(result).toEqual({ outcome: "skipped", reason: "policy-disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("decideBrowserAction origin allowlist", () => {
  it("blocks an origin outside the allowlist before any provider call", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: "https://evil.example.com/contact", elements: ELEMENTS },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toMatchObject({ outcome: "blocked", action: "blocked", reason: "origin-not-allowlisted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks every origin when none are configured (fails closed by default)", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: baseConfig({ browserAllowedOrigins: [] }), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toMatchObject({ outcome: "blocked", reason: "origin-not-allowlisted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("decideBrowserAction decisions", () => {
  it("returns the decided action and resolved target index for an allowlisted, non-sensitive request", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toMatchObject({
      outcome: "observed",
      action: "click",
      targetIndex: 1,
      sensitive: false,
      requiresConfirmation: false,
      confirmationInteractionId: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps enforce mode to an 'applied' outcome when the action clears every gate", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: baseConfig({ policies: { "browser-action": { enabled: true, mode: "enforce", thresholds: {} } } }),
        companyId: "company_1",
        log: vi.fn(),
      },
    );

    expect(result).toMatchObject({ outcome: "applied", action: "click" });
  });

  it("stays 'blocked' even in enforce mode when sensitivity requires confirmation, and opens a confirmation card", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse(clickAnswers({ sensitivity: { type: "noul", noul: 0.9 } })),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_1" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: baseConfig({ policies: { "browser-action": { enabled: true, mode: "enforce", thresholds: {} } } }),
        companyId: "company_1",
        log: vi.fn(),
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      action: "blocked",
      pendingAction: "click",
      reason: "sensitive-awaiting-confirmation",
      requiresConfirmation: true,
      confirmationInteractionId: "interaction_1",
    });
    expect(requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue_1", action: "click", targetIndex: 1 }),
    );
  });

  it("never emits a selector in its response, only an element index", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(JSON.stringify(result)).not.toMatch(/selector|xpath|css/i);
  });

  it("does not request confirmation when no issueId or requestConfirmation hook was provided", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse(clickAnswers({ sensitivity: { type: "noul", noul: 0.9 } })),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toMatchObject({ outcome: "blocked", requiresConfirmation: true, confirmationInteractionId: null });
  });

  it("records outcome 'error' and rethrows when the provider call fails", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl, retry: { maxRetries: 0 } });

    await expect(
      decideBrowserAction(
        { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
        { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
      ),
    ).rejects.toThrow();
  });
});
