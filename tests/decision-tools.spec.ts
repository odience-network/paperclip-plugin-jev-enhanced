import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import type { Fetch } from "@typesafe-ai/sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { WORK_KIND_CATALOG, MODEL_TIER_CATALOG, REVIEW_DEPTH_CATALOG } from "../src/policies/classify-task.js";
import { VERIFY_RELATION_CATALOG } from "../src/policies/verify.js";
import { utcDateKey } from "../src/jev/budget.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function choiceAnswer(choiceValue: string, options: readonly string[], confidence = 0.9) {
  const rest = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
  const probabilities = Object.fromEntries(options.map((option) => [option, option === choiceValue ? confidence : rest]));
  return { type: "choice" as const, choice: choiceValue, confidence, probabilities };
}

function noulAnswer(value: number) {
  return { type: "noul" as const, noul: value };
}

function fixtureResponseFor(answers: Record<string, unknown>) {
  return jsonResponse({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 5 } });
}

const WITH_BOUND_KEY = { config: { apiKeyRef: { type: "secret_ref" as const, secretId: "secret_1" } } };

function harnessWithFetch(fetchImpl: Fetch, extraConfig: Record<string, unknown> = {}) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "events.emit"],
    config: { ...WITH_BOUND_KEY.config, ...extraConfig },
  });
  harness.ctx.secrets.resolve = async () => "sk-test";
  harness.ctx.http.fetch = fetchImpl as typeof harness.ctx.http.fetch;
  return harness;
}

type Tool = "jev-ask" | "jev-classify-task" | "jev-verify" | "jev-rerank";

/**
 * `JevClient.ask` caches by policy + model + state/questions hash in a
 * process-lifetime cache (`worker.ts`'s module-level `jevCache`) — every
 * scenario below must use a distinct `nonce` so two tests for the same tool
 * never collide on a cache hit and silently skip each other's `fetchImpl`.
 */
function toolParams(tool: Tool, nonce: string): unknown {
  switch (tool) {
    case "jev-ask":
      return { state: `hello ${nonce}`, questions: { isBug: { type: "noul", instructions: "Is this a bug?" } } };
    case "jev-classify-task":
      return {
        description: `Fix the login bug (${nonce})`,
        candidateSkills: [{ id: "skill_1", name: "Auth" }],
      };
    case "jev-verify":
      return { claim: `this task is done (${nonce})`, evidence: "test suite: 42 passed, 0 failed" };
    case "jev-rerank":
      return {
        query: `how to reset a password (${nonce})`,
        candidates: [{ id: "c1", text: "Go to settings > reset password" }],
      };
  }
}

const TOOL_ANSWERS: Record<Tool, Record<string, unknown>> = {
  "jev-ask": { isBug: noulAnswer(0.8) },
  "jev-classify-task": {
    workKind: choiceAnswer("bug", WORK_KIND_CATALOG),
    modelTier: choiceAnswer("standard", MODEL_TIER_CATALOG),
    reviewDepth: choiceAnswer("standard", REVIEW_DEPTH_CATALOG),
    "loadSkill:skill_1": noulAnswer(0.9),
  },
  "jev-verify": { relation: choiceAnswer("supports", VERIFY_RELATION_CATALOG) },
  "jev-rerank": {
    "relevant:c1": noulAnswer(0.9),
    "containsAnswer:c1": noulAnswer(0.85),
    "injection:c1": noulAnswer(0.05),
  },
};

const TOOLS: Tool[] = ["jev-ask", "jev-classify-task", "jev-verify", "jev-rerank"];
const ROUTE_FOR: Record<Tool, string> = {
  "jev-ask": "tool-ask",
  "jev-classify-task": "tool-classify-task",
  "jev-verify": "tool-verify",
  "jev-rerank": "tool-rerank",
};

function apiInput(routeKey: string, body: unknown, overrides: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput {
  return {
    routeKey,
    method: "POST",
    path: `/tools/${routeKey}`,
    params: {},
    query: {},
    body,
    actor: { actorType: "agent", actorId: "agent_1", agentId: "agent_1", runId: "run_1" },
    companyId: "company_1",
    headers: {},
    ...overrides,
  };
}

describe("jev decision tools (MCP)", () => {
  for (const tool of TOOLS) {
    it(`${tool} succeeds and returns a typed result plus a ledger row`, async () => {
      const harness = harnessWithFetch(
        (async () => fixtureResponseFor(TOOL_ANSWERS[tool])) as Fetch,
      );
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<{ error?: string; data?: { outcome: string } }>(
        tool,
        toolParams(tool, "success-mcp"),
      );

      expect(result.error).toBeUndefined();
      expect(result.data?.outcome).toBe("observed");
    });

    it(`${tool} returns a typed "invalid-params" error (never throws) for malformed params`, async () => {
      const harness = harnessWithFetch((async () => fixtureResponseFor(TOOL_ANSWERS[tool])) as Fetch);
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<{ error?: string }>(tool, { nonsense: true });

      expect(result.error).toBe("invalid-params");
    });

    it(`${tool} returns a typed "validation-failed" error (never throws) when the provider response is malformed`, async () => {
      const harness = harnessWithFetch(
        (async () =>
          jsonResponse({
            model: "jev-1.13.0",
            answers: { bogus: { type: "choice", choice: "x", confidence: 0.9, probabilities: { x: 0.5, y: 0.2 } } },
            usage: { input_tokens: 10, output_tokens: 5 },
          })) as Fetch,
      );
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<{ error?: string }>(tool, toolParams(tool, "validation-mcp"));

      expect(result.error).toBe("validation-failed");
    });

    it(`${tool} returns a typed "budget-exceeded" error (never throws) once the daily token budget is exhausted`, async () => {
      const harness = harnessWithFetch((async () => fixtureResponseFor(TOOL_ANSWERS[tool])) as Fetch, {
        dailyTokenBudget: 10,
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: "company-test", namespace: "jev-budget", stateKey: utcDateKey() },
        { tokens: 10, costUsd: 0.01 },
      );

      const result = await harness.executeTool<{ error?: string }>(tool, toolParams(tool, "budget-mcp"));

      expect(result.error).toBe("budget-exceeded");
    });

    it(`${tool} returns a typed "missing-api-key" error (never throws) when no API key is bound`, async () => {
      const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<{ error?: string }>(tool, toolParams(tool, "missing-key-mcp"));

      expect(result.error).toBe("missing-api-key");
    });
  }
});

/**
 * Caller-supplied identifiers (question names, candidate/skill ids) become
 * ledger `answers` keys, so they're bounded to `/^[A-Za-z0-9_.:-]{1,64}$/`.
 * `jev-verify` has no identifier field and is intentionally excluded.
 */
const BAD_IDENTIFIER_PARAMS: Partial<Record<Tool, unknown>> = {
  "jev-ask": { state: "hello", questions: { "bad name!": { type: "noul", instructions: "Is this a bug?" } } },
  "jev-classify-task": {
    description: "Fix the login bug",
    candidateSkills: [{ id: "bad id!", name: "Auth" }],
  },
  "jev-rerank": {
    query: "how to reset a password",
    candidates: [{ id: "bad id!", text: "Go to settings > reset password" }],
  },
};

describe("jev decision tools reject out-of-shape caller-supplied identifiers", () => {
  for (const [tool, params] of Object.entries(BAD_IDENTIFIER_PARAMS) as [Tool, unknown][]) {
    it(`${tool} (MCP) returns "invalid-params" for an identifier outside [A-Za-z0-9_.:-]{1,64}`, async () => {
      const harness = harnessWithFetch((async () => fixtureResponseFor(TOOL_ANSWERS[tool])) as Fetch);
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<{ error?: string }>(tool, params);

      expect(result.error).toBe("invalid-params");
    });

    it(`${ROUTE_FOR[tool]} (route) returns HTTP 400 {error:"invalid-params"} for the same bad identifier`, async () => {
      const harness = harnessWithFetch((async () => fixtureResponseFor(TOOL_ANSWERS[tool])) as Fetch);
      await plugin.definition.setup(harness.ctx);

      const response = await plugin.definition.onApiRequest!(apiInput(ROUTE_FOR[tool], params));

      expect(response.status).toBe(400);
      expect((response.body as { error?: string }).error).toBe("invalid-params");
    });
  }
});

describe("jev decision tool API routes", () => {
  for (const tool of TOOLS) {
    const routeKey = ROUTE_FOR[tool];

    it(`${routeKey} succeeds with HTTP 200 and a typed body`, async () => {
      const harness = harnessWithFetch((async () => fixtureResponseFor(TOOL_ANSWERS[tool])) as Fetch);
      await plugin.definition.setup(harness.ctx);

      const response = await plugin.definition.onApiRequest!(apiInput(routeKey, toolParams(tool, "success-route")));

      expect(response.status).toBe(200);
      expect((response.body as { outcome?: string }).outcome).toBe("observed");
    });

    it(`${routeKey} returns HTTP 400 with {error:"invalid-params"} for malformed params`, async () => {
      const harness = harnessWithFetch((async () => fixtureResponseFor(TOOL_ANSWERS[tool])) as Fetch);
      await plugin.definition.setup(harness.ctx);

      const response = await plugin.definition.onApiRequest!(apiInput(routeKey, { nonsense: true }));

      expect(response.status).toBe(400);
      expect((response.body as { error?: string }).error).toBe("invalid-params");
    });

    it(`${routeKey} returns HTTP 502 with {error:"validation-failed"} when the provider response is malformed`, async () => {
      const harness = harnessWithFetch(
        (async () =>
          jsonResponse({
            model: "jev-1.13.0",
            answers: { bogus: { type: "choice", choice: "x", confidence: 0.9, probabilities: { x: 0.5, y: 0.2 } } },
            usage: { input_tokens: 10, output_tokens: 5 },
          })) as Fetch,
      );
      await plugin.definition.setup(harness.ctx);

      const response = await plugin.definition.onApiRequest!(apiInput(routeKey, toolParams(tool, "validation-route")));

      expect(response.status).toBe(502);
      expect((response.body as { error?: string }).error).toBe("validation-failed");
    });

    it(`${routeKey} returns HTTP 429 with {error:"budget-exceeded"} once the daily token budget is exhausted`, async () => {
      const harness = harnessWithFetch((async () => fixtureResponseFor(TOOL_ANSWERS[tool])) as Fetch, {
        dailyTokenBudget: 10,
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: "company_1", namespace: "jev-budget", stateKey: utcDateKey() },
        { tokens: 10, costUsd: 0.01 },
      );

      const response = await plugin.definition.onApiRequest!(apiInput(routeKey, toolParams(tool, "budget-route")));

      expect(response.status).toBe(429);
      expect((response.body as { error?: string }).error).toBe("budget-exceeded");
    });

    it(`${routeKey} returns HTTP 412 with {error:"missing-api-key"} when no API key is bound`, async () => {
      const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
      await plugin.definition.setup(harness.ctx);

      const response = await plugin.definition.onApiRequest!(apiInput(routeKey, toolParams(tool, "missing-key-route")));

      expect(response.status).toBe(412);
      expect((response.body as { error?: string }).error).toBe("missing-api-key");
    });
  }

  it("decisions-by-query requires issueId and returns 400 without it", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const response = await plugin.definition.onApiRequest!(
      apiInput("decisions-by-query", undefined, { method: "GET", path: "/decisions", query: {} }),
    );

    expect(response.status).toBe(400);
    expect((response.body as { error?: string }).error).toBe("issueId query param is required");
  });

  it("decisions-by-query reads the given companyId/issueId and the default limit", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const response = await plugin.definition.onApiRequest!(
      apiInput("decisions-by-query", undefined, {
        method: "GET",
        path: "/decisions",
        query: { issueId: "issue_1" },
        companyId: "company_1",
      }),
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    const query = harness.dbQueries.find((q) => q.sql.includes("jev_decisions"));
    expect(query?.params).toEqual(["company_1", "issue_1", 20]);
  });

  it("decisions-by-query returns 400 for a non-integer limit instead of silently ignoring it", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const response = await plugin.definition.onApiRequest!(
      apiInput("decisions-by-query", undefined, {
        method: "GET",
        path: "/decisions",
        query: { issueId: "issue_1", limit: "not-a-number" },
        companyId: "company_1",
      }),
    );

    expect(response.status).toBe(400);
    expect((response.body as { error?: string }).error).toBe("limit query param must be an integer");
  });

  it("decisions-by-query takes the first value of a repeated issueId/limit query param", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await plugin.definition.onApiRequest!(
      apiInput("decisions-by-query", undefined, {
        method: "GET",
        path: "/decisions",
        query: { issueId: ["issue_1", "issue_2"], limit: ["5", "9"] },
        companyId: "company_1",
      }),
    );

    const query = harness.dbQueries.find((q) => q.sql.includes("jev_decisions"));
    expect(query?.params).toEqual(["company_1", "issue_1", 5]);
  });
});
