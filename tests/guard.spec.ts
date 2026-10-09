import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "@typesafe-ai/sdk";
import { JevClient } from "../src/jev/client.js";
import { jevConfigSchema, type JevConfig } from "../src/config.js";
import type { LedgerDb } from "../src/ledger/db.js";
import { runRails, overrideStampKey, type RailDeps, type InteractionsReader } from "../src/guard/rails.js";
import type { LoopGuardState } from "../src/guard/loopGuard.js";
import { effectiveDecision } from "../src/guard/mode.js";
import { evaluateGuard, type EvaluateGuardDeps } from "../src/guard/evaluate.js";
import { guardPrePolicy } from "../src/guard/pre.js";
import { guardPostPolicy } from "../src/guard/post.js";
import { guardStopPolicy } from "../src/guard/stop.js";
import type { GuardEvaluateRequest } from "../src/guard/types.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createFakeDb(): LedgerDb & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    namespace: "plugin_jev_test",
    rows,
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

function createFakeState(): LoopGuardState {
  const store = new Map<string, unknown>();
  return {
    async get(input) {
      return store.get(`${input.scopeId}:${input.namespace}:${input.stateKey}`) ?? null;
    },
    async set(input, value) {
      store.set(`${input.scopeId}:${input.namespace}:${input.stateKey}`, value);
    },
  };
}

function createFakeInteractions(
  interactions: Array<{
    id: string;
    companyId: string;
    issueId: string;
    kind: string;
    status: string;
    resolvedAt?: string | null;
    resolvedByUserId?: string | null;
    resolvedByAgentId?: string | null;
    payload?: unknown;
  }>,
): InteractionsReader {
  return {
    async listInteractions(issueId, companyId) {
      return interactions.filter((i) => i.issueId === issueId && i.companyId === companyId);
    },
  };
}

function baseConfig(overrides: Partial<JevConfig> = {}): JevConfig {
  return jevConfigSchema.parse({ ...overrides });
}

function baseRequest(overrides: Partial<GuardEvaluateRequest> = {}): GuardEvaluateRequest {
  return { hookKind: "PreToolUse", runId: "run_1", toolName: "Bash", ...overrides };
}

describe("runRails", () => {
  it("fails closed on the kill switch deny-all override, before any tool checks", async () => {
    const config = baseConfig({ guardRails: { killSwitch: "deny-all" } as never }).guardRails;
    const deps: RailDeps = { state: createFakeState(), interactions: createFakeInteractions([]) };
    const verdict = await runRails(baseRequest({ toolName: "Read" }), "company_1", config, deps);
    expect(verdict).toEqual({ decision: "deny", reason: "kill-switch-deny-all", bypassMode: true });
  });

  it("bypasses everything on the kill switch allow-all override", async () => {
    const config = baseConfig({
      guardRails: { killSwitch: "allow-all", blockedTools: ["Bash"] } as never,
    }).guardRails;
    const deps: RailDeps = { state: createFakeState(), interactions: createFakeInteractions([]) };
    const verdict = await runRails(baseRequest({ toolName: "Bash" }), "company_1", config, deps);
    expect(verdict).toEqual({ decision: "allow", reason: "kill-switch-allow-all" });
  });

  it("denies a blocklisted tool without calling Jev", async () => {
    const config = baseConfig({ guardRails: { blockedTools: ["Bash"] } as never }).guardRails;
    const deps: RailDeps = { state: createFakeState(), interactions: createFakeInteractions([]) };
    const verdict = await runRails(baseRequest({ toolName: "Bash" }), "company_1", config, deps);
    expect(verdict).toEqual({ decision: "deny", reason: "tool-blocklisted", bypassMode: true });
  });

  it("allows an operator-allowlisted tool without calling Jev", async () => {
    const config = baseConfig({ guardRails: { alwaysAllowTools: ["Bash"] } as never }).guardRails;
    const deps: RailDeps = { state: createFakeState(), interactions: createFakeInteractions([]) };
    const verdict = await runRails(baseRequest({ toolName: "Bash" }), "company_1", config, deps);
    expect(verdict).toEqual({ decision: "allow", reason: "tool-always-allowed" });
  });

  it("allows a default read-only tool without calling Jev", async () => {
    const config = baseConfig().guardRails;
    const deps: RailDeps = { state: createFakeState(), interactions: createFakeInteractions([]) };
    const verdict = await runRails(baseRequest({ toolName: "Read" }), "company_1", config, deps);
    expect(verdict).toEqual({ decision: "allow", reason: "tool-read-only" });
  });

  it("does not rail a non-read-only, non-listed tool (falls through to Jev)", async () => {
    const config = baseConfig().guardRails;
    const deps: RailDeps = { state: createFakeState(), interactions: createFakeInteractions([]) };
    const verdict = await runRails(baseRequest({ toolName: "Edit" }), "company_1", config, deps);
    expect(verdict).toBeNull();
  });

  it("trips the loop guard after the configured threshold of identical (tool, inputHash) calls", async () => {
    const config = baseConfig({ guardRails: { loopGuard: { threshold: 3, windowSize: 8, action: "ask" } } as never })
      .guardRails;
    const state = createFakeState();
    const deps: RailDeps = { state, interactions: createFakeInteractions([]) };
    const request = baseRequest({ toolName: "Edit", toolInputHash: "hash-a" });

    expect(await runRails(request, "company_1", config, deps)).toBeNull();
    expect(await runRails(request, "company_1", config, deps)).toBeNull();
    const verdict = await runRails(request, "company_1", config, deps);
    expect(verdict).toEqual({ decision: "ask", reason: "loop-detected", bypassMode: true });
  });

  it("the loop guard never forces allow — only ask or deny", async () => {
    const config = baseConfig({ guardRails: { loopGuard: { threshold: 2, windowSize: 8, action: "deny" } } as never })
      .guardRails;
    const state = createFakeState();
    const deps: RailDeps = { state, interactions: createFakeInteractions([]) };
    const request = baseRequest({ toolName: "Edit", toolInputHash: "hash-b" });

    await runRails(request, "company_1", config, deps);
    const verdict = await runRails(request, "company_1", config, deps);
    expect(verdict).toEqual({ decision: "deny", reason: "loop-detected", bypassMode: true });
  });

  describe("override stamp", () => {
    const config = baseConfig().guardRails;
    const TOOL_NAME = "Edit";
    const TOOL_INPUT_HASH = "hash-1";
    const target = { type: "custom", key: overrideStampKey(TOOL_NAME, TOOL_INPUT_HASH) };

    function overrideRequest(overrides: Partial<GuardEvaluateRequest> = {}): GuardEvaluateRequest {
      return baseRequest({
        toolName: TOOL_NAME,
        toolInputHash: TOOL_INPUT_HASH,
        issueId: "issue_1",
        overrideInteractionId: "int_1",
        ...overrides,
      });
    }

    it("accepts a fresh, accepted, human-resolved request_confirmation interaction bound to this exact call", async () => {
      const resolvedAt = new Date().toISOString();
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          {
            id: "int_1",
            companyId: "company_1",
            issueId: "issue_1",
            kind: "request_confirmation",
            status: "accepted",
            resolvedAt,
            resolvedByUserId: "user_1",
            payload: { target },
          },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", config, deps);
      expect(verdict).toEqual({ decision: "allow", reason: "human-override-stamp" });
    });

    it("rejects an override stamp resolved by an agent, even if resolvedByUserId is also set", async () => {
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          {
            id: "int_1",
            companyId: "company_1",
            issueId: "issue_1",
            kind: "request_confirmation",
            status: "accepted",
            resolvedAt: new Date().toISOString(),
            resolvedByUserId: "user_1",
            resolvedByAgentId: "agent_1",
            payload: { target },
          },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", config, deps);
      expect(verdict).toBeNull();
    });

    it("rejects an override stamp with no human resolver at all", async () => {
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          {
            id: "int_1",
            companyId: "company_1",
            issueId: "issue_1",
            kind: "request_confirmation",
            status: "accepted",
            resolvedAt: new Date().toISOString(),
            payload: { target },
          },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", config, deps);
      expect(verdict).toBeNull();
    });

    it("rejects an override stamp bound to a different tool call (toolInputHash mismatch)", async () => {
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          {
            id: "int_1",
            companyId: "company_1",
            issueId: "issue_1",
            kind: "request_confirmation",
            status: "accepted",
            resolvedAt: new Date().toISOString(),
            resolvedByUserId: "user_1",
            payload: { target: { type: "custom", key: overrideStampKey(TOOL_NAME, "a-different-hash") } },
          },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", config, deps);
      expect(verdict).toBeNull();
    });

    it("rejects an override stamp with no target binding at all", async () => {
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          {
            id: "int_1",
            companyId: "company_1",
            issueId: "issue_1",
            kind: "request_confirmation",
            status: "accepted",
            resolvedAt: new Date().toISOString(),
            resolvedByUserId: "user_1",
          },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", config, deps);
      expect(verdict).toBeNull();
    });

    it("ignores an override stamp with no issueId on the request", async () => {
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          { id: "int_1", companyId: "company_1", issueId: "issue_1", kind: "request_confirmation", status: "accepted", resolvedAt: new Date().toISOString(), resolvedByUserId: "user_1", payload: { target } },
        ]),
      };
      const request = overrideRequest({ issueId: undefined });
      const verdict = await runRails(request, "company_1", config, deps);
      expect(verdict).toBeNull();
    });

    it("ignores an override stamp for the wrong company (falls through, never denies outright)", async () => {
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          { id: "int_1", companyId: "company_other", issueId: "issue_1", kind: "request_confirmation", status: "accepted", resolvedAt: new Date().toISOString(), resolvedByUserId: "user_1", payload: { target } },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", config, deps);
      expect(verdict).toBeNull();
    });

    it("ignores an override stamp that is not status accepted", async () => {
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          { id: "int_1", companyId: "company_1", issueId: "issue_1", kind: "request_confirmation", status: "pending", resolvedAt: null, resolvedByUserId: "user_1", payload: { target } },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", config, deps);
      expect(verdict).toBeNull();
    });

    it("ignores an override stamp of the wrong interaction kind", async () => {
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          { id: "int_1", companyId: "company_1", issueId: "issue_1", kind: "hire_agent", status: "accepted", resolvedAt: new Date().toISOString(), resolvedByUserId: "user_1", payload: { target } },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", config, deps);
      expect(verdict).toBeNull();
    });

    it("rejects a stale override stamp outside the freshness window", async () => {
      const staleConfig = baseConfig({ guardRails: { overrideFreshnessMs: 1_000 } as never }).guardRails;
      const resolvedAt = new Date(Date.now() - 10_000).toISOString();
      const deps: RailDeps = {
        state: createFakeState(),
        interactions: createFakeInteractions([
          { id: "int_1", companyId: "company_1", issueId: "issue_1", kind: "request_confirmation", status: "accepted", resolvedAt, resolvedByUserId: "user_1", payload: { target } },
        ]),
      };
      const verdict = await runRails(overrideRequest(), "company_1", staleConfig, deps);
      expect(verdict).toBeNull();
    });
  });

  it("checks the tool blocklist before the override stamp, so a blocked tool can't be unblocked by a human override", async () => {
    const toolName = "Bash";
    const toolInputHash = "hash-blocked";
    const blockedConfig = baseConfig({ guardRails: { blockedTools: [toolName] } as never }).guardRails;
    const deps: RailDeps = {
      state: createFakeState(),
      interactions: createFakeInteractions([
        {
          id: "int_1",
          companyId: "company_1",
          issueId: "issue_1",
          kind: "request_confirmation",
          status: "accepted",
          resolvedAt: new Date().toISOString(),
          resolvedByUserId: "user_1",
          payload: { target: { type: "custom", key: overrideStampKey(toolName, toolInputHash) } },
        },
      ]),
    };
    const request = baseRequest({ toolName, toolInputHash, issueId: "issue_1", overrideInteractionId: "int_1" });
    const verdict = await runRails(request, "company_1", blockedConfig, deps);
    expect(verdict).toEqual({ decision: "deny", reason: "tool-blocklisted", bypassMode: true });
  });
});

describe("effectiveDecision", () => {
  it("shadow mode never blocks, regardless of the intended decision", () => {
    expect(effectiveDecision("shadow", "allow")).toBe("allow");
    expect(effectiveDecision("shadow", "ask")).toBe("allow");
    expect(effectiveDecision("shadow", "deny")).toBe("allow");
  });

  it("suggest mode downgrades deny to ask but passes allow/ask through", () => {
    expect(effectiveDecision("suggest", "allow")).toBe("allow");
    expect(effectiveDecision("suggest", "ask")).toBe("ask");
    expect(effectiveDecision("suggest", "deny")).toBe("ask");
  });

  it("enforce mode returns the intended decision verbatim", () => {
    expect(effectiveDecision("enforce", "allow")).toBe("allow");
    expect(effectiveDecision("enforce", "ask")).toBe("ask");
    expect(effectiveDecision("enforce", "deny")).toBe("deny");
  });
});

describe("guardPrePolicy.decide", () => {
  const ctx = { companyId: "company_1", config: { enabled: true, mode: "shadow" as const, thresholds: {}, alwaysAuto: false, options: {} } };

  function answers(overrides: Record<string, unknown> = {}) {
    return {
      risk: { type: "score" as const, score: 0, legend: {}, probabilities: {}, confidence: 0.9 },
      secrets_exposure: { type: "noul" as const, noul: 0 },
      destructive: { type: "noul" as const, noul: 0 },
      exfiltration: { type: "noul" as const, noul: 0 },
      from_untrusted_source: { type: "noul" as const, noul: 0 },
      on_task: { type: "noul" as const, noul: 0.9 },
      user_requested: { type: "noul" as const, noul: 0 },
      ...overrides,
    };
  }

  it("denies on secrets exposure even at low overall risk score", () => {
    const verdict = guardPrePolicy.decide(answers({ secrets_exposure: { type: "noul", noul: 0.9 } }), ctx);
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toBe("secrets-exposure");
  });

  it("denies a destructive call that was not user-requested", () => {
    const verdict = guardPrePolicy.decide(answers({ destructive: { type: "noul", noul: 0.9 } }), ctx);
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toBe("destructive-not-user-requested");
  });

  it("allows a destructive call when the user explicitly requested it", () => {
    const verdict = guardPrePolicy.decide(
      answers({ destructive: { type: "noul", noul: 0.9 }, user_requested: { type: "noul", noul: 0.95 } }),
      ctx,
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("allows an elevated-risk call when the user explicitly requested it", () => {
    const verdict = guardPrePolicy.decide(
      answers({
        risk: { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 0.8 },
        user_requested: { type: "noul", noul: 0.95 },
      }),
      ctx,
    );
    expect(verdict.verdict).toBe("allow");
  });

  it("asks on elevated risk when the user did not request it", () => {
    const verdict = guardPrePolicy.decide(
      answers({ risk: { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 0.8 } }),
      ctx,
    );
    expect(verdict.verdict).toBe("ask");
    expect(verdict.reason).toBe("risk-score-elevated");
  });

  it("asks when the call appears off-task from the issue objective", () => {
    const verdict = guardPrePolicy.decide(answers({ on_task: { type: "noul", noul: 0.1 } }), ctx);
    expect(verdict.verdict).toBe("ask");
    expect(verdict.reason).toBe("off-task");
  });

  it("allows a low-risk, on-task call", () => {
    const verdict = guardPrePolicy.decide(answers(), ctx);
    expect(verdict.verdict).toBe("allow");
    expect(verdict.reason).toBe("low-risk");
  });
});

describe("guardPostPolicy.decide", () => {
  const ctx = { companyId: "company_1", config: { enabled: true, mode: "shadow" as const, thresholds: {}, alwaysAuto: false, options: {} } };

  it("denies clear prompt injection in tool output", () => {
    const verdict = guardPostPolicy.decide(
      { injection: { type: "noul", noul: 0.95 }, kind: { type: "choice", choice: "prompt_injection", probabilities: { prompt_injection: 1 }, confidence: 0.9 } },
      ctx,
    );
    expect(verdict.verdict).toBe("deny");
  });

  it("allows output with no injection detected", () => {
    const verdict = guardPostPolicy.decide(
      { injection: { type: "noul", noul: 0.02 }, kind: { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 0.95 } },
      ctx,
    );
    expect(verdict.verdict).toBe("allow");
  });
});

describe("guardStopPolicy.decide", () => {
  const ctx = { companyId: "company_1", config: { enabled: true, mode: "shadow" as const, thresholds: {}, alwaysAuto: false, options: {} } };

  it("never denies — only allow or ask", () => {
    const unsupported = guardStopPolicy.decide({ completion_supported: { type: "noul", noul: 0.05 } }, ctx);
    expect(unsupported.verdict).toBe("ask");
    const supported = guardStopPolicy.decide({ completion_supported: { type: "noul", noul: 0.9 } }, ctx);
    expect(supported.verdict).toBe("allow");
  });
});

describe("evaluateGuard", () => {
  function deps(overrides: Partial<EvaluateGuardDeps> = {}, fetchImpl?: Fetch): EvaluateGuardDeps {
    const client = new JevClient({
      resolveApiKey: async () => "test-key",
      fetchImpl:
        fetchImpl ??
        (async () =>
          jsonResponse({
            model: "jev-1.13.0",
            answers: {
              risk: { type: "score", score: 0, legend: {}, probabilities: { "0": 1 }, confidence: 0.9 },
              secrets_exposure: { type: "noul", noul: 0 },
              destructive: { type: "noul", noul: 0 },
              exfiltration: { type: "noul", noul: 0 },
              from_untrusted_source: { type: "noul", noul: 0 },
              on_task: { type: "noul", noul: 0.9 },
              user_requested: { type: "noul", noul: 0 },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          })),
      retry: { maxRetries: 0 },
    });
    return {
      client,
      db: createFakeDb(),
      rails: { state: createFakeState(), interactions: createFakeInteractions([]) },
      config: baseConfig(),
      companyId: "company_1",
      agentId: "agent_1",
      issue: { title: "Fix the bug", description: "Do the thing" },
      ...overrides,
    };
  }

  it("rails short-circuit and skip the Jev call entirely", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({}));
    const d = deps(
      {
        config: baseConfig({
          guardRails: { blockedTools: ["Bash"] } as never,
          policies: { "guard-pre": { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} } },
        }),
      },
      fetchImpl,
    );
    const result = await evaluateGuard(baseRequest({ toolName: "Bash" }), d);
    expect(result.decision).toBe("deny");
    expect(result.rail).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes a ledger row before completing, carrying no excerpt/free text", async () => {
    const d = deps();
    await evaluateGuard(baseRequest({ toolName: "Edit", excerpt: "rm -rf /tmp/scratch" }), d);
    const rows = [...(d.db as ReturnType<typeof createFakeDb>).rows.values()];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("rm -rf");
  });

  it("shadow mode never blocks even when the intended decision is deny", async () => {
    const d = deps(
      {},
      async () =>
        jsonResponse({
          model: "jev-1.13.0",
          answers: {
            risk: { type: "score", score: 0, legend: {}, probabilities: { "0": 1 }, confidence: 0.9 },
            secrets_exposure: { type: "noul", noul: 0.95 },
            destructive: { type: "noul", noul: 0 },
            exfiltration: { type: "noul", noul: 0 },
            from_untrusted_source: { type: "noul", noul: 0 },
            on_task: { type: "noul", noul: 0.9 },
            user_requested: { type: "noul", noul: 0 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
    );
    const result = await evaluateGuard(baseRequest({ toolName: "Edit" }), d);
    expect(result.decision).toBe("allow");
    expect(result.intendedDecision).toBe("deny");
  });

  it("the kill switch deny-all is NOT downgraded to allow by shadow mode (bypassMode rails ignore the policy's mode)", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({}));
    const d = deps(
      {
        config: baseConfig({
          guardRails: { killSwitch: "deny-all" } as never,
          policies: { "guard-pre": { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } },
        }),
      },
      fetchImpl,
    );
    const result = await evaluateGuard(baseRequest({ toolName: "Edit" }), d);
    expect(result.decision).toBe("deny");
    expect(result.intendedDecision).toBe("deny");
    expect(result.rail).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the kill switch deny-all forces ask (never deny) for Stop, which has no deny in its decision space", async () => {
    const d = deps({
      config: baseConfig({
        guardRails: { killSwitch: "deny-all" } as never,
        policies: { "guard-stop": { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } },
      }),
    });
    const result = await evaluateGuard(baseRequest({ hookKind: "Stop", toolName: undefined }), d);
    expect(result.decision).toBe("ask");
  });

  it("a blocklisted tool is NOT downgraded to allow by shadow mode", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({}));
    const d = deps(
      {
        config: baseConfig({
          guardRails: { blockedTools: ["Bash"] } as never,
          policies: { "guard-pre": { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } },
        }),
      },
      fetchImpl,
    );
    const result = await evaluateGuard(baseRequest({ toolName: "Bash" }), d);
    expect(result.decision).toBe("deny");
    expect(result.rail).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a tripped loop guard is NOT downgraded to allow by shadow mode", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({}));
    const config = baseConfig({
      guardRails: { loopGuard: { threshold: 2, windowSize: 8, action: "deny" } } as never,
      policies: { "guard-pre": { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } },
    });
    const state = createFakeState();
    const request = baseRequest({ toolName: "Edit", toolInputHash: "loop-hash" });
    const d = deps({ config, rails: { state, interactions: createFakeInteractions([]) } }, fetchImpl);

    await evaluateGuard(request, d);
    const result = await evaluateGuard(request, d);
    expect(result.decision).toBe("deny");
    expect(result.rail).toBe(true);
  });

  it("a rail bypassMode decision is recorded in the ledger as blocked, not observed, even in shadow mode", async () => {
    const d = deps({
      config: baseConfig({
        guardRails: { killSwitch: "deny-all" } as never,
        policies: { "guard-pre": { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } },
      }),
    });
    await evaluateGuard(baseRequest({ toolName: "Edit" }), d);
    const rows = [...(d.db as ReturnType<typeof createFakeDb>).rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("blocked");
  });

  it("fails open to allow on a Jev error when the policy is not enforce", async () => {
    const d = deps({ config: baseConfig({ policies: { "guard-pre": { enabled: true, mode: "suggest", thresholds: {}, alwaysAuto: false, options: {} } } }) }, async () =>
      jsonResponse({ error: "boom" }, { status: 500 }));
    const result = await evaluateGuard(baseRequest({ toolName: "Edit" }), d);
    expect(result.decision).toBe("allow");
    expect(result.rail).toBe(false);
  });

  it("fails closed to ask (never deny) on a Jev error when the policy is enforce", async () => {
    const d = deps({ config: baseConfig({ policies: { "guard-pre": { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} } } }) }, async () =>
      jsonResponse({ error: "boom" }, { status: 500 }));
    const result = await evaluateGuard(baseRequest({ toolName: "Edit" }), d);
    expect(result.decision).toBe("ask");
  });

  it("Stop always fails open to allow, even in enforce mode, since it has no deny", async () => {
    const d = deps(
      { config: baseConfig({ policies: { "guard-stop": { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} } } }) },
      async () => jsonResponse({ error: "boom" }, { status: 500 }),
    );
    const result = await evaluateGuard(baseRequest({ hookKind: "Stop", excerpt: "done" }), d);
    expect(result.decision).toBe("allow");
  });

  it("honors the time budget: times out to the fallback decision rather than waiting on a slow Jev call", async () => {
    const d = deps(
      { config: baseConfig({ guardRails: { timeBudgetMs: 20 } as never, policies: { "guard-pre": { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} } } }) },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return jsonResponse({
          model: "jev-1.13.0",
          answers: { risk: { type: "score", score: 0, legend: {}, probabilities: { "0": 1 }, confidence: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    );
    const started = Date.now();
    const result = await evaluateGuard(baseRequest({ toolName: "Edit" }), d);
    expect(Date.now() - started).toBeLessThan(150);
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("time-budget-exceeded");
  });

  it("completes the ledger row with the late result after a timeout, without throwing", async () => {
    const d = deps(
      { config: baseConfig({ guardRails: { timeBudgetMs: 20 } as never }) },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return jsonResponse({
          model: "jev-1.13.0",
          answers: {
            risk: { type: "score", score: 0, legend: {}, probabilities: { "0": 1 }, confidence: 0.9 },
            secrets_exposure: { type: "noul", noul: 0 },
            destructive: { type: "noul", noul: 0 },
            exfiltration: { type: "noul", noul: 0 },
            from_untrusted_source: { type: "noul", noul: 0 },
            on_task: { type: "noul", noul: 0.9 },
            user_requested: { type: "noul", noul: 0 },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    );
    await evaluateGuard(baseRequest({ toolName: "Edit" }), d);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = [...(d.db as ReturnType<typeof createFakeDb>).rows.values()];
    expect(rows[0].outcome).toBe("observed");
    expect(rows[0].reason).toContain("after-timeout");
  });

  it("a disabled policy allows without calling Jev", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({}));
    const d = deps({ config: baseConfig({ policies: { "guard-pre": { enabled: false, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } } }) }, fetchImpl);
    const result = await evaluateGuard(baseRequest({ toolName: "Edit" }), d);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("policy-disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
