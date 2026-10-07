import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "@typesafe-ai/sdk";
import { JevClient } from "../src/jev/client.js";
import { pingPolicy } from "../src/policies/ping.js";
import { runPolicy } from "../src/policies/run.js";
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
  return jevConfigSchema.parse({ ...overrides });
}

describe("pingPolicy", () => {
  it("pre-filters out an empty message", () => {
    const ctx = {
      companyId: "company_1",
      config: { enabled: true, mode: "shadow" as const, thresholds: {}, alwaysAuto: false, options: {} },
    };
    expect(pingPolicy.preFilter({ message: "" }, ctx)).toBe(false);
    expect(pingPolicy.preFilter({ message: "ping" }, ctx)).toBe(true);
  });

  it("decides pong when the noul probability clears the threshold", () => {
    const ctx = {
      companyId: "company_1",
      config: { enabled: true, mode: "shadow" as const, thresholds: { pong: 0.6 }, alwaysAuto: false, options: {} },
    };
    const verdict = pingPolicy.decide({ pong: { type: "noul", noul: 0.9 } }, ctx);
    expect(verdict.verdict).toBe("pong");
    expect(verdict.confidence).toBe(0.9);
  });

  it("decides no-pong when the noul probability misses the threshold", () => {
    const ctx = {
      companyId: "company_1",
      config: { enabled: true, mode: "shadow" as const, thresholds: { pong: 0.6 }, alwaysAuto: false, options: {} },
    };
    const verdict = pingPolicy.decide({ pong: { type: "noul", noul: 0.4 } }, ctx);
    expect(verdict.verdict).toBe("no-pong");
  });
});

describe("runPolicy", () => {
  it("writes a decision row before the provider call and completes it with the outcome for shadow mode", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { pong: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const db = createFakeDb();
    const applyLog = vi.fn();

    const result = await runPolicy(
      {
        policy: pingPolicy,
        state: { message: "ping" },
        config: baseConfig(),
        companyId: "company_1",
        issueId: "issue_1",
      },
      { client, db, apply: { log: applyLog }, suggest: { log: vi.fn() } },
    );

    expect(result).toMatchObject({ outcome: "observed" });
    expect(applyLog).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips disabled policies without calling the provider", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const db = createFakeDb();

    const result = await runPolicy(
      {
        policy: pingPolicy,
        state: { message: "ping" },
        config: baseConfig({
          policies: { ping: { enabled: false, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } },
        }),
        companyId: "company_1",
        issueId: "issue_1",
      },
      { client, db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
    );

    expect(result).toEqual({ outcome: "skipped", reason: "policy-disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("applies the decision only when the policy's mode is enforce", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { pong: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const client = new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
    const db = createFakeDb();
    const applyLog = vi.fn();

    const result = await runPolicy(
      {
        policy: pingPolicy,
        state: { message: "ping" },
        config: baseConfig({
          policies: { ping: { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} } },
        }),
        companyId: "company_1",
        issueId: "issue_1",
      },
      { client, db, apply: { log: applyLog }, suggest: { log: vi.fn() } },
    );

    expect(result).toMatchObject({ outcome: "applied" });
    expect(applyLog).toHaveBeenCalledWith("jev.apply.ping", expect.objectContaining({ verdict: "pong" }));
  });

  it("records outcome 'error' and rethrows when the provider call fails", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({ error: "boom" }, { status: 500 }));
    const client = new JevClient({
      resolveApiKey: async () => "test-key",
      fetchImpl,
      retry: { maxRetries: 0 },
    });
    const db = createFakeDb();

    await expect(
      runPolicy(
        {
          policy: pingPolicy,
          state: { message: "ping" },
          config: baseConfig(),
          companyId: "company_1",
          issueId: "issue_1",
        },
        { client, db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
      ),
    ).rejects.toThrow();
  });
});
