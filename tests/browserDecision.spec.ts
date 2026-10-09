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
        config: baseConfig({
          policies: { "browser-action": { enabled: false, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } },
        }),
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

function suggestConfig(overrides: Partial<JevConfig> = {}) {
  return baseConfig({
    policies: { "browser-action": { enabled: true, mode: "suggest", thresholds: {}, alwaysAuto: false, options: {} } },
    ...overrides,
  });
}

describe("decideBrowserAction shadow mode", () => {
  it("is non-actionable by default: action is 'blocked' even when the policy would have acted", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toMatchObject({
      outcome: "observed",
      action: "blocked",
      observedAction: "click",
      reason: "shadow-mode",
      targetIndex: 1,
      sensitive: false,
      requiresConfirmation: false,
      confirmationInteractionId: null,
    });
  });

  it("never opens a confirmation card, even when the action would be sensitivity-gated", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse(clickAnswers({ sensitivity: { type: "noul", noul: 0.9 } })),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_1" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn(), requestConfirmation },
    );

    expect(result).toMatchObject({
      outcome: "observed",
      action: "blocked",
      observedAction: "click",
      requiresConfirmation: false,
      confirmationInteractionId: null,
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("keeps the deterministic block reason (not 'shadow-mode') when a gate would have blocked anyway", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse(clickAnswers({ target_0: { type: "noul", noul: 0.1 }, target_1: { type: "noul", noul: 0.1 } })),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: baseConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toMatchObject({ outcome: "observed", action: "blocked", reason: "no-target-resolved" });
  });
});

describe("decideBrowserAction suggest/enforce mode", () => {
  it("returns the decided action and resolved target index for an allowlisted, non-sensitive request", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: suggestConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toMatchObject({
      outcome: "suggested",
      action: "click",
      observedAction: "click",
      targetIndex: 1,
      sensitive: false,
      requiresConfirmation: false,
      confirmationInteractionId: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps enforce mode to a 'suggested' outcome (never 'applied') since the tool is always advisory", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: baseConfig({
          policies: { "browser-action": { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} } },
        }),
        companyId: "company_1",
        log: vi.fn(),
      },
    );

    expect(result).toMatchObject({ outcome: "suggested", action: "click" });
  });

  it("never emits a selector in its response, only an element index", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: suggestConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(JSON.stringify(result)).not.toMatch(/selector|xpath|css/i);
  });

  it("sends only origin + pathname to the provider, never the query string or fragment", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse(clickAnswers()));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    await decideBrowserAction(
      { goal: GOAL, url: `${ALLOWED_URL}?token=secret123#fragment-token`, elements: ELEMENTS },
      { client, db: createFakeDb(), config: suggestConfig(), companyId: "company_1", log: vi.fn() },
    );

    const [, requestInit] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(String(requestInit?.body));
    expect(JSON.stringify(body)).not.toMatch(/token=secret123|fragment-token/);
    expect(JSON.stringify(body)).toContain(ALLOWED_URL);
  });

  it("records outcome 'error' and rethrows when the provider call fails", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl, retry: { maxRetries: 0 } });

    await expect(
      decideBrowserAction(
        { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
        { client, db: createFakeDb(), config: suggestConfig(), companyId: "company_1", log: vi.fn() },
      ),
    ).rejects.toThrow();
  });
});

describe("decideBrowserAction confirm-mutation workflow", () => {
  function sensitiveFetch() {
    return vi.fn<Fetch>(async () => jsonResponse(clickAnswers({ sensitivity: { type: "noul", noul: 0.9 } })));
  }

  it("opens a confirmation card with an idempotency key when none exists yet", async () => {
    const fetchImpl = sensitiveFetch();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const findConfirmation = vi.fn(async () => null);
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_1" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: suggestConfig(),
        companyId: "company_1",
        log: vi.fn(),
        findConfirmation,
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      action: "blocked",
      observedAction: "click",
      reason: "sensitive-awaiting-confirmation",
      requiresConfirmation: true,
      confirmationInteractionId: "interaction_1",
    });
    expect(findConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue_1", idempotencyKey: expect.stringContaining("jev:browser:issue_1:") }),
    );
    expect(requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "issue_1",
        action: "click",
        targetIndex: 1,
        url: ALLOWED_URL,
        idempotencyKey: expect.stringContaining("jev:browser:issue_1:"),
      }),
    );
  });

  it("does not open a new card when a matching one is already pending", async () => {
    const fetchImpl = sensitiveFetch();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const findConfirmation = vi.fn(async () => ({ id: "interaction_existing", status: "pending" as const }));
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_new" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: suggestConfig(),
        companyId: "company_1",
        log: vi.fn(),
        findConfirmation,
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({
      action: "blocked",
      requiresConfirmation: true,
      confirmationInteractionId: "interaction_existing",
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("unblocks with the observed action once a human accepts the confirmation", async () => {
    const fetchImpl = sensitiveFetch();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const findConfirmation = vi.fn(async () => ({ id: "interaction_existing", status: "accepted" as const }));
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_new" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: suggestConfig(),
        companyId: "company_1",
        log: vi.fn(),
        findConfirmation,
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({
      outcome: "suggested",
      action: "click",
      observedAction: "click",
      reason: "human-confirmed",
      requiresConfirmation: false,
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("stays blocked for good once a human rejects the confirmation, without re-asking", async () => {
    const fetchImpl = sensitiveFetch();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const findConfirmation = vi.fn(async () => ({ id: "interaction_existing", status: "rejected" as const }));
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_new" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: suggestConfig(),
        companyId: "company_1",
        log: vi.fn(),
        findConfirmation,
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      action: "blocked",
      reason: "human-rejected",
      requiresConfirmation: false,
      confirmationInteractionId: null,
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("opens a new card when a prior one for the same key already expired", async () => {
    const fetchImpl = sensitiveFetch();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const findConfirmation = vi.fn(async () => ({ id: "interaction_stale", status: "expired" as const }));
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_new" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: suggestConfig(),
        companyId: "company_1",
        log: vi.fn(),
        findConfirmation,
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({ confirmationInteractionId: "interaction_new" });
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });

  it("does not request confirmation when no issueId or requestConfirmation hook was provided", async () => {
    const fetchImpl = sensitiveFetch();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });

    const result = await decideBrowserAction(
      { goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      { client, db: createFakeDb(), config: suggestConfig(), companyId: "company_1", log: vi.fn() },
    );

    expect(result).toMatchObject({ outcome: "blocked", requiresConfirmation: true, confirmationInteractionId: null });
  });

  it("does not corrupt the ledger row when requestConfirmation throws: stays 'blocked', not 'error'", async () => {
    const fetchImpl = sensitiveFetch();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const findConfirmation = vi.fn(async () => null);
    const requestConfirmation = vi.fn(async () => {
      throw new Error("issue thread unavailable");
    });

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: suggestConfig(),
        companyId: "company_1",
        log: vi.fn(),
        findConfirmation,
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      action: "blocked",
      requiresConfirmation: true,
      confirmationInteractionId: null,
    });
  });

  it("never opens a confirmation card for a sensitive action with no resolved target", async () => {
    // Regression: `decide()` used to gate sensitivity before the target
    // check, so a sensitive click with no resolved target still opened a
    // confirmation card — accepting it would have unblocked `targetIndex:
    // null`. It must block as `no-target-resolved` instead, and never call
    // either confirmation hook.
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse(
        clickAnswers({
          sensitivity: { type: "noul", noul: 0.9 },
          target_0: { type: "noul", noul: 0.1 },
          target_1: { type: "noul", noul: 0.2 },
        }),
      ),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const findConfirmation = vi.fn(async () => null);
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_1" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: suggestConfig(),
        companyId: "company_1",
        log: vi.fn(),
        findConfirmation,
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      action: "blocked",
      targetIndex: null,
      reason: "no-target-resolved",
      requiresConfirmation: false,
      confirmationInteractionId: null,
    });
    expect(findConfirmation).not.toHaveBeenCalled();
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("falls back to 'not found' (and still gates) when findConfirmation throws", async () => {
    const fetchImpl = sensitiveFetch();
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const findConfirmation = vi.fn(async () => {
      throw new Error("read failed");
    });
    const requestConfirmation = vi.fn(async () => ({ interactionId: "interaction_1" }));

    const result = await decideBrowserAction(
      { issueId: "issue_1", goal: GOAL, url: ALLOWED_URL, elements: ELEMENTS },
      {
        client,
        db: createFakeDb(),
        config: suggestConfig(),
        companyId: "company_1",
        log: vi.fn(),
        findConfirmation,
        requestConfirmation,
      },
    );

    expect(result).toMatchObject({ action: "blocked", confirmationInteractionId: "interaction_1" });
  });
});
