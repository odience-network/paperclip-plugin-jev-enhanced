import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueComment } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { createFakeDb } from "./helpers/fake-db.js";
import { beginDecision, completeDecision, getDecisionById, getLatestDecision } from "../src/ledger/decisions.js";
import { getFeedbackSummary, recordFeedback } from "../src/ledger/feedback.js";

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date();
  return {
    id: "issue_1",
    companyId: "company_1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Login button does nothing",
    description: "Clicking login does not navigate anywhere.",
    status: "todo",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "ISS-1",
    originId: null,
    originRunId: null,
    originFingerprint: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Issue;
}

/** A bound-and-reachable `askOutcome` for `issue-triage`'s questions, shaped
 * like the fixtures in `tests/jev-client.spec.ts` — `owner: "unassigned"` is
 * a sentinel `decide()` never turns into an `apply` field write, so this is
 * safe to reuse regardless of mode. */
function fakeIssueTriageFetch() {
  return (async () =>
    new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          owner: { type: "choice", choice: "unassigned", probabilities: { unassigned: 0.9, needs_triage: 0.1 }, confidence: 0.9 },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as never;
}

function fakeComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "comment_1",
    companyId: "company_1",
    issueId: "issue_1",
    authorType: "user",
    authorAgentId: null,
    authorUserId: "user_1",
    body: "Can someone confirm the rollout window for this?",
    presentation: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as IssueComment;
}

describe("plugin scaffold", () => {
  it("declares capabilities for its manifest features", () => {
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("ui.dashboardWidget.register");
  });

  it("declares capabilities needed for comment-triage and run-outcome-qa side effects", () => {
    expect(manifest.capabilities).toContain("events.emit");
    expect(manifest.capabilities).toContain("issues.wakeup");
    expect(manifest.capabilities).toContain("issue.comments.read");
    expect(manifest.capabilities).toContain("issue.comments.create");
  });

  it("registers data + actions", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const data = await harness.getData<{ status: string }>("health");
    expect(data.status).toBe("ok");

    const action = await harness.performAction<{ pong: boolean }>("ping");
    expect(action.pong).toBe(true);
  });

  it("handles issue.created without making a network call when no API key is bound", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    // No `apiKeyRef` is configured, so the ping policy's provider call must
    // fail closed before ever touching the network — the event handler
    // catches and logs that failure rather than throwing.
    await expect(
      harness.emit("issue.created", {}, { entityId: "iss_1", entityType: "issue" }),
    ).resolves.not.toThrow();
  });

  it("handles issue.comment.created without making a network call when no API key is bound", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.seed({
      issues: [fakeIssue()],
      issueComments: [fakeComment()],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.emit(
        "issue.comment.created",
        { commentId: "comment_1" },
        { entityId: "issue_1", entityType: "issue", companyId: "company_1" },
      ),
    ).resolves.not.toThrow();
  });

  it("handles agent.run.finished without making a network call when no API key is bound", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.seed({
      issues: [fakeIssue()],
      issueComments: [fakeComment({ id: "comment_2", createdByRunId: "run_1", body: "Done." })],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.emit(
        "agent.run.finished",
        { runId: "run_1", agentId: "agent_1", status: "succeeded", issueId: "issue_1" },
        { entityId: "run_1", entityType: "heartbeat_run", companyId: "company_1" },
      ),
    ).resolves.not.toThrow();
  });

  it("handles agent.run.failed without making a network call when no API key is bound", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.seed({
      issues: [fakeIssue()],
      issueComments: [],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.emit(
        "agent.run.failed",
        { runId: "run_1", agentId: "agent_1", status: "failed", issueId: "issue_1" },
        { entityId: "run_1", entityType: "heartbeat_run", companyId: "company_1" },
      ),
    ).resolves.not.toThrow();
  });

  it("comment-triage-feed scopes by company and the comment-triage policy name, defaulting the limit to 20", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.getData("comment-triage-feed", { companyId: "company_1" });

    const query = harness.dbQueries.find((q) => q.sql.includes("policy = $2"));
    expect(query?.params).toEqual(["company_1", "comment-triage", 20]);
  });

  it("comment-triage-feed rejects calls with no companyId", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("comment-triage-feed", {})).rejects.toThrow(/companyId is required/);
  });

  it("degrades gracefully (not an error, not a false ok) when no API key is bound", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toMatch(/console\.typesafe\.ai/);
  });

  it("checks GET /v1/models with the bound key and reports ok when reachable", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    harness.ctx.secrets.resolve = async () => "sk-test";
    harness.ctx.http.fetch = (async () =>
      new Response(JSON.stringify({ models: [{ id: "jev-1.13.0" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof harness.ctx.http.fetch;
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });

  it("validateConfig degrades to a warning (not an error) when no API key is bound", async () => {
    const result = await plugin.definition.onValidateConfig?.({});
    expect(result?.ok).toBe(true);
    expect(result?.warnings?.[0]).toMatch(/console\.typesafe\.ai/);
  });

  it("validateConfig makes a real Test Connection call and passes when TypeSafe is reachable", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    harness.ctx.secrets.resolve = async () => "sk-test";
    harness.ctx.http.fetch = (async () =>
      new Response(JSON.stringify({ models: [{ id: "jev-1.13.0" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof harness.ctx.http.fetch;
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onValidateConfig?.({
      apiKeyRef: { type: "secret_ref", secretId: "secret_1" },
    });
    expect(result?.ok).toBe(true);
    expect(result?.warnings ?? []).toHaveLength(0);
  });

  it("validateConfig reports ok:false when TypeSafe rejects the bound key (401/403)", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    harness.ctx.secrets.resolve = async () => "sk-bad";
    harness.ctx.http.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof harness.ctx.http.fetch;
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onValidateConfig?.({
      apiKeyRef: { type: "secret_ref", secretId: "secret_1" },
    });
    expect(result?.ok).toBe(false);
    expect(result?.errors?.[0]).toMatch(/rejected the bound key/);
  });

  it("validateConfig degrades to a warning (not ok:false) on a network failure", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    harness.ctx.secrets.resolve = async () => "sk-test";
    harness.ctx.http.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof harness.ctx.http.fetch;
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onValidateConfig?.({
      apiKeyRef: { type: "secret_ref", secretId: "secret_1" },
    });
    expect(result?.ok).toBe(true);
    expect(result?.warnings?.[0]).toMatch(/Could not verify the connection/);
  });

  it("decisions-history falls back to the default limit when params.limit is NaN or fractional", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.getData("decisions-history", { companyId: "company_1", issueId: "issue_1", limit: Number.NaN });
    await harness.getData("decisions-history", { companyId: "company_1", issueId: "issue_1", limit: 2.5 });

    const limitQueries = harness.dbQueries.filter((q) => q.sql.includes("LIMIT $3"));
    expect(limitQueries).toHaveLength(2);
    for (const query of limitQueries) {
      expect(query.params?.[2]).toBe(20);
    }
  });

  it("decisions-history passes an in-range integer limit through unchanged", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.getData("decisions-history", { companyId: "company_1", issueId: "issue_1", limit: 5 });

    const limitQuery = harness.dbQueries.find((q) => q.sql.includes("LIMIT $3"));
    expect(limitQuery?.params?.[2]).toBe(5);
  });

  it("decisions-history trusts whatever companyId lands in params.companyId, including an unscoped (admin-only) bridge call that the host leaves unoverridden — see the requireCompanyId doc comment", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    // The real host only omits its own authorized scope for an unscoped,
    // instance-admin-only bridge call; the test harness's `getData` always
    // passes `params` straight through, so this simulates that path.
    await harness.getData("decisions-history", { companyId: "company_admin_supplied", issueId: "issue_1" });

    const query = harness.dbQueries.find((q) => q.sql.includes("LIMIT $3"));
    expect(query?.params?.[0]).toBe("company_admin_supplied");
  });

  it("decisions-latest and decisions-history reject calls with no companyId at all", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("decisions-latest", { issueId: "issue_1" })).rejects.toThrow(/companyId is required/);
    await expect(harness.getData("decisions-history", { issueId: "issue_1" })).rejects.toThrow(/companyId is required/);
  });
});

describe("plugin scaffold > T5 issue tab data", () => {
  it("decisions-latest-by-policy returns empty arrays when the issue has no decisions yet", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.ctx.db = createFakeDb();
    await plugin.definition.setup(harness.ctx);

    const result = await harness.getData<{ decisions: unknown[]; feedback: unknown[] }>(
      "decisions-latest-by-policy",
      { companyId: "company_1", issueId: "issue_1" },
    );
    expect(result).toEqual({ decisions: [], feedback: [] });
  });

  it("decisions-latest-by-policy requires companyId", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.ctx.db = createFakeDb();
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("decisions-latest-by-policy", { issueId: "issue_1" })).rejects.toThrow(
      "companyId is required",
    );
  });

  it("decisions-latest-by-policy returns the latest decision per policy plus its feedback", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    const db = createFakeDb();
    harness.ctx.db = db;
    await plugin.definition.setup(harness.ctx);

    const id = await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });
    await completeDecision(db, id, {
      stateHash: "abc",
      answers: { pong: { type: "noul", noul: 0.9 } },
      confidence: 0.9,
      margin: 0.4,
      latencyMs: 120,
      usage: { input_tokens: 10, output_tokens: 5 },
      costUsd: 0.0001,
      outcome: "observed",
      reason: "noul-above-threshold",
    });

    const result = await harness.getData<{
      decisions: Array<{ id: string; policy: string }>;
      feedback: unknown[];
    }>("decisions-latest-by-policy", { companyId: "company_1", issueId: "issue_1" });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.id).toBe(id);
    expect(result.decisions[0]?.policy).toBe("ping");
    expect(result.feedback).toEqual([]);
  });

  it("feedback action records accept/override and round-trips through the ledger", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    const db = createFakeDb();
    harness.ctx.db = db;
    await plugin.definition.setup(harness.ctx);

    const decisionId = await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });

    const result = await harness.performAction<{ id: string; decisionId: string; verdict: string }>(
      "feedback",
      { decisionId, verdict: "override", note: "disagree" },
      { companyId: "company_1", actor: { type: "user", userId: "user_1" } },
    );
    expect(result.verdict).toBe("override");
    expect(result.decisionId).toBe(decisionId);

    const summary = await getFeedbackSummary(db, "company_1");
    expect(summary).toEqual({ total: 1, accept: 0, override: 1, agreementRate: 0 });

    expect(await getDecisionById(db, "company_1", decisionId)).not.toBeNull();
  });

  it("feedback action rejects a decisionId that belongs to another company", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    const db = createFakeDb();
    harness.ctx.db = db;
    await plugin.definition.setup(harness.ctx);

    const decisionId = await beginDecision(db, {
      companyId: "company_2",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });

    await expect(
      harness.performAction(
        "feedback",
        { decisionId, verdict: "accept" },
        { companyId: "company_1", actor: { type: "user", userId: "user_1" } },
      ),
    ).rejects.toThrow("Decision not found for this company");
  });

  it("feedback action requires a decisionId", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.ctx.db = createFakeDb();
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.performAction("feedback", { verdict: "accept" }, { companyId: "company_1" }),
    ).rejects.toThrow("decisionId is required");
  });

  it("triage-issue (manual, via the action the UI's \"Triage now\" button calls) fails closed for an issue from another company", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    const db = createFakeDb();
    harness.ctx.db = db;
    harness.seed({ issues: [fakeIssue({ id: "issue_1", companyId: "company_2" })] });
    await plugin.definition.setup(harness.ctx);

    // The caller is authorized for company_1; the issue belongs to
    // company_2. `ctx.issues.get` fails closed (returns null for a
    // cross-company id), so this must skip, not throw, and must never write
    // a ledger row — company_1 has no issue_1, so there's nothing for the
    // caller to even address.
    const result = await harness.performAction(
      "triage-issue",
      { issueId: "issue_1" },
      { companyId: "company_1", actor: { type: "user", userId: "user_1" } },
    );
    expect(result).toEqual({ outcome: "skipped", reason: "policy-disabled-or-issue-not-found" });
    expect(await getLatestDecision(db, "company_1", "issue_1")).toBeNull();
    expect(await getLatestDecision(db, "company_2", "issue_1")).toBeNull();
  });

  it("triage-issue (manual) records a shadow-mode decision for an issue in the caller's own company", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    const db = createFakeDb();
    harness.ctx.db = db;
    harness.ctx.secrets.resolve = async () => "sk-test";
    harness.seed({ issues: [fakeIssue({ id: "issue_1", companyId: "company_1" })] });
    harness.ctx.http.fetch = fakeIssueTriageFetch();
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{ outcome: string }>(
      "triage-issue",
      { issueId: "issue_1" },
      { companyId: "company_1", actor: { type: "user", userId: "user_1" } },
    );
    // No policy config is set, so `issue-triage` runs with its default
    // config — shadow mode, per "every policy ships in shadow mode".
    expect(result.outcome).toBe("observed");

    const decision = await getLatestDecision(db, "company_1", "issue_1");
    expect(decision?.policy).toBe("issue-triage");
    expect(decision?.mode).toBe("shadow");
    expect(decision?.outcome).toBe("observed");
  });

  it("triage-issue requires an issueId", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.ctx.db = createFakeDb();
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.performAction("triage-issue", {}, { companyId: "company_1" }),
    ).rejects.toThrow("issueId and an authorized companyId are required");
  });
});

describe("plugin scaffold > T5 dashboard data", () => {
  it("dashboard-summary reports zeroed-out metrics and unbound provider health for a fresh company", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.ctx.db = createFakeDb();
    await plugin.definition.setup(harness.ctx);

    const summary = await harness.getData<{
      dailyStats: unknown[];
      modeSplit: Record<string, number>;
      feedbackSummary: { total: number };
      providerHealth: { status: string };
    }>("dashboard-summary", { companyId: "company_1" });

    expect(summary.dailyStats).toEqual([]);
    expect(summary.modeSplit).toEqual({ shadow: 0, suggest: 0, enforce: 0 });
    expect(summary.feedbackSummary.total).toBe(0);
    expect(summary.providerHealth.status).toBe("unbound");
  });

  it("dashboard-summary aggregates decisions per day, mode split, and feedback agreement", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    const db = createFakeDb();
    harness.ctx.db = db;
    await plugin.definition.setup(harness.ctx);

    const decisionId = await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "enforce",
    });
    await recordFeedback(db, { decisionId, userId: "user_1", verdict: "accept" });

    const summary = await harness.getData<{
      dailyStats: Array<{ decisionCount: number }>;
      modeSplit: Record<string, number>;
      feedbackSummary: { total: number; agreementRate: number | null };
    }>("dashboard-summary", { companyId: "company_1" });

    expect(summary.dailyStats).toHaveLength(1);
    expect(summary.dailyStats[0]?.decisionCount).toBe(1);
    expect(summary.modeSplit).toEqual({ shadow: 0, suggest: 0, enforce: 1 });
    expect(summary.feedbackSummary).toEqual({ total: 1, accept: 1, override: 0, agreementRate: 1 });
  });

  it("dashboard-summary requires companyId", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.ctx.db = createFakeDb();
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("dashboard-summary", {})).rejects.toThrow("companyId is required");
  });

  it("calibration-summary returns the committed eval report for ping", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.ctx.db = createFakeDb();
    await plugin.definition.setup(harness.ctx);

    const reports = await harness.getData<Record<string, { policy: string; metrics: { count: number } }>>(
      "calibration-summary",
    );
    expect(reports.ping?.policy).toBe("ping");
    expect(reports.ping?.metrics.count).toBeGreaterThan(0);
  });
});
