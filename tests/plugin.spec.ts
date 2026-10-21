import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueComment } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue_1",
    companyId: "company_1",
    title: "Test issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    projectId: null,
    originKind: undefined,
    labels: [],
    labelIds: [],
    ...overrides,
  } as unknown as Issue;
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
