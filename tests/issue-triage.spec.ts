import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "@typesafe-ai/sdk";
import { JevClient } from "../src/jev/client.js";
import { issueTriagePolicy, type IssueTriageState } from "../src/policies/issue-triage.js";
import { runPolicy } from "../src/policies/run.js";
import type { PolicyContext } from "../src/policies/types.js";
import type { JevAnswer } from "../src/jev/types.js";
import { jevConfigSchema, type JevConfig } from "../src/config.js";
import type { LedgerDb } from "../src/ledger/db.js";
import { hashState } from "../src/jev/redact.js";

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

function baseState(overrides: Partial<IssueTriageState> = {}): IssueTriageState {
  return {
    issueId: "issue_1",
    title: "Login button does nothing",
    description: "Clicking login does not navigate anywhere.",
    priority: "medium",
    hasOwner: false,
    hasUserAssignee: false,
    hasProject: true,
    existingLabelNames: [],
    existingLabelIds: [],
    isFirstTriage: true,
    isPluginOrigin: false,
    eligibleAgents: [{ id: "agent_1", name: "Ada", role: "engineer" }],
    candidateProjects: [],
    recentOpenIssues: [],
    issueTypes: issueTriagePolicy.questionVersion ? ["bug", "feature", "chore", "docs", "question"] : [],
    ...overrides,
  };
}

function baseCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    companyId: "company_1",
    issueId: "issue_1",
    config: { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} },
    respectExistingFields: true,
    alwaysAuto: false,
    ...overrides,
  };
}

function ownerAnswer(choiceValue: string, confidence = 0.9): JevAnswer {
  const rest = 1 - confidence;
  // Picks an "other" probability key distinct from `choiceValue` — using a
  // fixed "unassigned" fallback silently collided (and dropped a key) when
  // `choiceValue` itself was "unassigned".
  const other = choiceValue === "unassigned" ? "needs_triage" : "unassigned";
  return {
    type: "choice",
    choice: choiceValue,
    confidence,
    probabilities: { [choiceValue]: confidence, [other]: rest },
  };
}

function priorityAnswer(choiceValue: string, confidence = 0.9): JevAnswer {
  const rest = 1 - confidence;
  return {
    type: "choice",
    choice: choiceValue,
    confidence,
    probabilities: { [choiceValue]: confidence, low: rest },
  };
}

describe("issueTriagePolicy.preFilter", () => {
  it("skips issues created by the plugin itself", () => {
    const state = baseState({ isPluginOrigin: true });
    expect(issueTriagePolicy.preFilter(state, baseCtx())).toBe(false);
  });

  it("skips when the state hash matches the prior decision's state hash", () => {
    const state = baseState();
    const ctx = baseCtx({ stateHash: "same-hash", priorStateHash: "same-hash" });
    expect(issueTriagePolicy.preFilter(state, ctx)).toBe(false);
  });

  it("does not skip when the state hash differs from the prior decision", () => {
    const state = baseState();
    const ctx = baseCtx({ stateHash: "new-hash", priorStateHash: "old-hash" });
    expect(issueTriagePolicy.preFilter(state, ctx)).toBe(true);
  });

  it("skips when owner and project are already set by a human and this is not the first triage", () => {
    const state = baseState({ hasOwner: true, hasProject: true, isFirstTriage: false });
    expect(issueTriagePolicy.preFilter(state, baseCtx())).toBe(false);
  });

  it("does not skip an already-triaged issue when alwaysAuto is set", () => {
    const state = baseState({ hasOwner: true, hasProject: true, isFirstTriage: false });
    const ctx = baseCtx({ alwaysAuto: true });
    expect(issueTriagePolicy.preFilter(state, ctx)).toBe(true);
  });

  it("does not skip an already-triaged issue when respectExistingFields is false", () => {
    const state = baseState({ hasOwner: true, hasProject: true, isFirstTriage: false });
    const ctx = baseCtx({ respectExistingFields: false });
    expect(issueTriagePolicy.preFilter(state, ctx)).toBe(true);
  });

  it("does not skip the issue's first-ever triage even if owner and project are set", () => {
    const state = baseState({ hasOwner: true, hasProject: true, isFirstTriage: true });
    expect(issueTriagePolicy.preFilter(state, baseCtx())).toBe(true);
  });
});

describe("issueTriagePolicy.identityState", () => {
  it("is unaffected by isFirstTriage flipping or candidate names/titles changing", () => {
    const a = baseState({
      isFirstTriage: true,
      eligibleAgents: [{ id: "agent_1", name: "Ada", role: "engineer" }],
      recentOpenIssues: [{ id: "issue_2", identifier: "ODIAA-2", title: "Original title" }],
    });
    const b = baseState({
      isFirstTriage: false,
      eligibleAgents: [{ id: "agent_1", name: "Renamed Ada", role: "staff-engineer" }],
      recentOpenIssues: [{ id: "issue_2", identifier: "ODIAA-2", title: "Edited elsewhere" }],
    });

    expect(issueTriagePolicy.identityState!(a)).toEqual(issueTriagePolicy.identityState!(b));
  });

  it("changes when the eligible agent id set changes", () => {
    const a = baseState({ eligibleAgents: [{ id: "agent_1", name: "Ada", role: "engineer" }] });
    const b = baseState({
      eligibleAgents: [
        { id: "agent_1", name: "Ada", role: "engineer" },
        { id: "agent_2", name: "Grace", role: "engineer" },
      ],
    });

    expect(issueTriagePolicy.identityState!(a)).not.toEqual(issueTriagePolicy.identityState!(b));
  });

  it("is unaffected by the recentOpenIssues set changing (unrelated issue opened/closed elsewhere)", () => {
    const a = baseState({ recentOpenIssues: [] });
    const b = baseState({ recentOpenIssues: [{ id: "issue_2", identifier: "ODIAA-2", title: "New issue" }] });

    // recentOpenIssues is company-wide "other open issues right now", not
    // intrinsic to this issue — every newly opened/closed issue elsewhere
    // must not invalidate every backlog issue's identity hash.
    expect(issueTriagePolicy.identityState!(a)).toEqual(issueTriagePolicy.identityState!(b));
  });

  it("changes when title or description changes", () => {
    const a = baseState({ title: "Original" });
    const b = baseState({ title: "Edited" });
    expect(issueTriagePolicy.identityState!(a)).not.toEqual(issueTriagePolicy.identityState!(b));
  });
});

describe("issueTriagePolicy.questions", () => {
  it("never interpolates the issue's own title/description or another issue's title into question text", () => {
    const state = baseState({
      title: "SECRET_TITLE_TOKEN",
      description: "SECRET_DESCRIPTION_TOKEN",
      recentOpenIssues: [{ id: "issue_2", identifier: "ODIAA-2", title: "SECRET_OTHER_ISSUE_TITLE" }],
    });
    const questions = issueTriagePolicy.questions(state, baseCtx());
    const serialized = JSON.stringify(questions);

    expect(serialized).not.toContain("SECRET_TITLE_TOKEN");
    expect(serialized).not.toContain("SECRET_DESCRIPTION_TOKEN");
    expect(serialized).not.toContain("SECRET_OTHER_ISSUE_TITLE");
  });
});

describe("issueTriagePolicy.decide", () => {
  it("applies the owner field when confidence and margin clear the thresholds and no owner is set", () => {
    const state = baseState({ hasOwner: false });
    const ctx = baseCtx({ config: { enabled: true, mode: "enforce", thresholds: { confidenceMin: 0.7, marginMin: 0.15 }, alwaysAuto: false, options: {} } });
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("agent_1", 0.9) }, ctx, state);

    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField).toMatchObject({ action: "apply", value: "agent_1" });
    expect(verdict.verdict).toBe("assign:agent_1");
  });

  it("marks the owner field 'observe' when confidence is below threshold", () => {
    const state = baseState({ hasOwner: false });
    const ctx = baseCtx({ config: { enabled: true, mode: "enforce", thresholds: { confidenceMin: 0.95, marginMin: 0.15 }, alwaysAuto: false, options: {} } });
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("agent_1", 0.6) }, ctx, state);

    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField).toMatchObject({ action: "observe", reason: "below-threshold" });
  });

  it("marks the owner field 'observe' when the candidate-set size is at or above the configured maximum", () => {
    const state = baseState({
      hasOwner: false,
      eligibleAgents: Array.from({ length: 5 }, (_, i) => ({ id: `agent_${i}`, name: `Agent ${i}`, role: "engineer" })),
    });
    const ctx = baseCtx({ config: { enabled: true, mode: "enforce", thresholds: { confidenceMin: 0.5, marginMin: 0.1, maxCandidates: 5 }, alwaysAuto: false, options: {} } });
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("agent_0", 0.9) }, ctx, state);

    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField).toMatchObject({ action: "observe", reason: "below-threshold" });
  });

  it("never proposes overriding an existing owner unless alwaysAuto is set", () => {
    const state = baseState({ hasOwner: true });
    const ctx = baseCtx();
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("agent_1", 0.9) }, ctx, state);

    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField).toMatchObject({ action: "suggest", reason: "respects-existing-field" });
  });

  it("allows overriding an existing owner when alwaysAuto is set", () => {
    const state = baseState({ hasOwner: true });
    const ctx = baseCtx({ alwaysAuto: true });
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("agent_1", 0.9) }, ctx, state);

    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField).toMatchObject({ action: "apply" });
  });

  it("never proposes assigneeAgentId while a human user already owns the issue, even with alwaysAuto", () => {
    const state = baseState({ hasOwner: true, hasUserAssignee: true });
    const ctx = baseCtx({ alwaysAuto: true });
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("agent_1", 0.9) }, ctx, state);

    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField).toMatchObject({ action: "suggest", reason: "respects-existing-field" });
  });

  it("never auto-clears an existing owner via a sentinel answer, even with alwaysAuto", () => {
    const state = baseState({ hasOwner: true, hasUserAssignee: false });
    const ctx = baseCtx({ alwaysAuto: true });
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("unassigned", 0.9) }, ctx, state);

    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField).toMatchObject({ action: "suggest", reason: "respects-existing-field", value: null });
  });

  it("applies a sentinel (clearing) answer when nothing is assigned yet", () => {
    const state = baseState({ hasOwner: false, hasUserAssignee: false });
    const ctx = baseCtx();
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("needs_triage", 0.9) }, ctx, state);

    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField).toMatchObject({ action: "apply", value: null });
  });

  it("never emits an assigneeUserId field, only assigneeAgentId or no-op sentinels", () => {
    const state = baseState({ hasOwner: false });
    const ctx = baseCtx();
    const verdict = issueTriagePolicy.decide({ owner: ownerAnswer("needs_triage", 0.9) }, ctx, state);

    expect(verdict.fields?.some((f) => f.field === "assigneeUserId")).toBe(false);
    const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
    expect(ownerField?.value).toBeNull();
    expect(verdict.verdict).toBe("needs_triage");
  });

  it("allows priority on the first-ever triage even with respectExistingFields", () => {
    const state = baseState({ isFirstTriage: true });
    const ctx = baseCtx();
    const verdict = issueTriagePolicy.decide(
      { owner: ownerAnswer("unassigned", 0.9), priority: priorityAnswer("high", 0.9) },
      ctx,
      state,
    );

    const priorityField = verdict.fields?.find((f) => f.field === "priority");
    expect(priorityField).toMatchObject({ action: "apply", value: "high" });
  });

  it("respects a human-reviewed priority on re-triage unless alwaysAuto", () => {
    const state = baseState({ isFirstTriage: false });
    const ctx = baseCtx();
    const verdict = issueTriagePolicy.decide(
      { owner: ownerAnswer("unassigned", 0.9), priority: priorityAnswer("high", 0.9) },
      ctx,
      state,
    );

    const priorityField = verdict.fields?.find((f) => f.field === "priority");
    expect(priorityField).toMatchObject({ action: "suggest", reason: "respects-existing-field" });
  });

  it("applies issueType only when options.issueTypeLabelIds maps the answer to a label id", () => {
    const state = baseState();
    const withMapping = baseCtx({
      config: { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: { issueTypeLabelIds: { bug: "label_bug" } } },
    });
    const withoutMapping = baseCtx();

    const answers: Record<string, JevAnswer> = {
      owner: ownerAnswer("unassigned", 0.9),
      issueType: { type: "choice", choice: "bug", confidence: 0.9, probabilities: { bug: 0.9, feature: 0.1 } },
    };

    const mappedVerdict = issueTriagePolicy.decide(answers, withMapping, state);
    expect(mappedVerdict.fields?.find((f) => f.field === "issueType")).toMatchObject({ action: "apply" });

    const unmappedVerdict = issueTriagePolicy.decide(answers, withoutMapping, state);
    expect(unmappedVerdict.fields?.find((f) => f.field === "issueType")).toMatchObject({
      action: "observe",
      reason: "no-applicable-field",
    });
  });

  it("always records complexity, needsMoreContext, likelyBlocked, duplicate and fitsProject answers as observe-only", () => {
    const state = baseState({
      hasProject: false,
      candidateProjects: [{ id: "project_1", name: "Core" }],
      recentOpenIssues: [{ id: "issue_2", identifier: "ODIAA-2", title: "Another bug" }],
    });
    const ctx = baseCtx();
    const answers: Record<string, JevAnswer> = {
      owner: ownerAnswer("unassigned", 0.9),
      complexity: { type: "score", score: 1, legend: { "1": "small" }, confidence: 0.9, probabilities: { "0": 0.05, "1": 0.9, "2": 0.03, "3": 0.02 } },
      needsMoreContext: { type: "noul", noul: 0.9 },
      likelyBlocked: { type: "noul", noul: 0.1 },
      duplicateExists: { type: "noul", noul: 0.8 },
      duplicateOf: { type: "choice", choice: "issue_2", confidence: 0.9, probabilities: { issue_2: 0.9, none: 0.1 } },
      "fitsProject:project_1": { type: "noul", noul: 0.9 },
    };

    const verdict = issueTriagePolicy.decide(answers, ctx, state);
    for (const field of ["complexity", "needsMoreContext", "likelyBlocked", "duplicateExists", "duplicateOf", "fitsProject:project_1"]) {
      expect(verdict.fields?.find((f) => f.field === field)).toMatchObject({ action: "observe", reason: "no-applicable-field" });
    }
  });

  it("returns a no-answer verdict when the owner answer is missing", () => {
    const state = baseState();
    const ctx = baseCtx();
    const verdict = issueTriagePolicy.decide({}, ctx, state);
    expect(verdict).toMatchObject({ verdict: "no-answer", confidence: null, margin: null, reason: "missing-or-invalid-answer" });
  });
});

describe("issueTriagePolicy via runPolicy", () => {
  function policyConfig(mode: "shadow" | "suggest" | "enforce") {
    return {
      issue_triage_cfg: { enabled: true, mode, thresholds: { confidenceMin: 0.7, marginMin: 0.15 }, alwaysAuto: false, options: {} },
    };
  }

  function configFor(mode: "shadow" | "suggest" | "enforce"): JevConfig {
    return baseConfig({ policies: { "issue-triage": policyConfig(mode).issue_triage_cfg } });
  }

  function fakeClient(answers: Record<string, unknown>): JevClient {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 5 } }),
    );
    return new JevClient({ resolveApiKey: async () => "test-key", fetchImpl });
  }

  it("shadow mode only records the decision: no apply or suggest side effects", async () => {
    const client = fakeClient({ owner: ownerAnswer("agent_1", 0.9) });
    const db = createFakeDb();
    const applyLog = vi.fn();
    const requestConfirmation = vi.fn();

    const result = await runPolicy(
      {
        policy: issueTriagePolicy,
        state: baseState({ hasOwner: false }),
        config: configFor("shadow"),
        companyId: "company_1",
        issueId: "issue_1",
      },
      { client, db, apply: { log: applyLog, updateIssue: vi.fn() }, suggest: { log: vi.fn(), requestConfirmation } },
    );

    expect(result).toMatchObject({ outcome: "observed" });
    expect(applyLog).not.toHaveBeenCalled();
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("suggest mode posts a request_confirmation listing the proposed fields and never patches the issue", async () => {
    const client = fakeClient({ owner: ownerAnswer("agent_1", 0.9) });
    const db = createFakeDb();
    const updateIssue = vi.fn();
    const requestConfirmation = vi.fn();

    const result = await runPolicy(
      {
        policy: issueTriagePolicy,
        state: baseState({ hasOwner: false }),
        config: configFor("suggest"),
        companyId: "company_1",
        issueId: "issue_1",
      },
      { client, db, apply: { log: vi.fn(), updateIssue }, suggest: { log: vi.fn(), requestConfirmation } },
    );

    expect(result).toMatchObject({ outcome: "suggested" });
    expect(updateIssue).not.toHaveBeenCalled();
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    const call = requestConfirmation.mock.calls[0][0];
    expect(call.issueId).toBe("issue_1");
    expect(call.detailsMarkdown).toContain("assigneeAgentId");
  });

  it("enforce mode patches only the fields decide() marked 'apply', and never assigneeUserId", async () => {
    const client = fakeClient({ owner: ownerAnswer("agent_1", 0.9) });
    const db = createFakeDb();
    const updateIssue = vi.fn();

    const result = await runPolicy(
      {
        policy: issueTriagePolicy,
        state: baseState({ hasOwner: false }),
        config: configFor("enforce"),
        companyId: "company_1",
        issueId: "issue_1",
      },
      { client, db, apply: { log: vi.fn(), updateIssue }, suggest: { log: vi.fn(), requestConfirmation: vi.fn() } },
    );

    expect(result).toMatchObject({ outcome: "applied" });
    expect(updateIssue).toHaveBeenCalledTimes(1);
    const call = updateIssue.mock.calls[0][0];
    expect(call.patch).toEqual({ assigneeAgentId: "agent_1" });
    expect(call.patch.assigneeUserId).toBeUndefined();
  });

  it("enforce mode merges an issueType label onto existing labels instead of replacing them", async () => {
    const client = fakeClient({
      owner: ownerAnswer("unassigned", 0.9),
      issueType: { type: "choice", choice: "bug", confidence: 0.9, probabilities: { bug: 0.9, feature: 0.1 } },
    });
    const db = createFakeDb();
    const updateIssue = vi.fn();
    const config = baseConfig({
      policies: {
        "issue-triage": {
          enabled: true,
          mode: "enforce",
          thresholds: { confidenceMin: 0.7, marginMin: 0.15 },
          alwaysAuto: false,
          options: { issueTypeLabelIds: { bug: "label_bug" } },
        },
      },
    });

    const result = await runPolicy(
      {
        policy: issueTriagePolicy,
        state: baseState({ hasOwner: false, existingLabelIds: ["label_frontend", "label_p1"] }),
        config,
        companyId: "company_1",
        issueId: "issue_1",
      },
      { client, db, apply: { log: vi.fn(), updateIssue }, suggest: { log: vi.fn(), requestConfirmation: vi.fn() } },
    );

    expect(result).toMatchObject({ outcome: "applied" });
    expect(updateIssue).toHaveBeenCalledTimes(1);
    const call = updateIssue.mock.calls[0][0];
    expect(new Set(call.patch.labelIds)).toEqual(new Set(["label_frontend", "label_p1", "label_bug"]));
  });

  it("enforce mode never patches an existing human-set owner unless alwaysAuto", async () => {
    const client = fakeClient({ owner: ownerAnswer("agent_1", 0.9) });
    const db = createFakeDb();
    const updateIssue = vi.fn();

    const result = await runPolicy(
      {
        policy: issueTriagePolicy,
        state: baseState({ hasOwner: true }),
        config: configFor("enforce"),
        companyId: "company_1",
        issueId: "issue_1",
      },
      { client, db, apply: { log: vi.fn(), updateIssue }, suggest: { log: vi.fn(), requestConfirmation: vi.fn() } },
    );

    expect(result).toMatchObject({ outcome: "applied" });
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("is idempotent: preFilter skips a second run against the same unchanged state", async () => {
    const client = fakeClient({ owner: ownerAnswer("agent_1", 0.9) });
    const db = createFakeDb();
    const state = baseState({ hasOwner: false });
    const config = configFor("shadow");

    const first = await runPolicy(
      { policy: issueTriagePolicy, state, config, companyId: "company_1", issueId: "issue_1" },
      { client, db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
    );
    expect(first.outcome).toBe("observed");

    const priorStateHash = hashState(issueTriagePolicy.identityState!(state), config.redactionPatterns);
    const second = await runPolicy(
      { policy: issueTriagePolicy, state, config, companyId: "company_1", issueId: "issue_1", priorStateHash },
      { client, db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
    );
    expect(second).toEqual({ outcome: "skipped", reason: "pre-filter" });
  });

  it("still skips re-triage when an unrelated issue opens and changes the recentOpenIssues candidate set", async () => {
    const client = fakeClient({ owner: ownerAnswer("agent_1", 0.9) });
    const db = createFakeDb();
    const config = configFor("shadow");
    const stateBeforeUnrelatedIssue = baseState({ hasOwner: false, recentOpenIssues: [] });

    const first = await runPolicy(
      { policy: issueTriagePolicy, state: stateBeforeUnrelatedIssue, config, companyId: "company_1", issueId: "issue_1" },
      { client, db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
    );
    expect(first.outcome).toBe("observed");

    const priorStateHash = hashState(issueTriagePolicy.identityState!(stateBeforeUnrelatedIssue), config.redactionPatterns);

    // A backlog sweep now runs again after an unrelated issue was opened
    // elsewhere in the company — nothing about *this* issue changed, but
    // `recentOpenIssues` (the company-wide "other open issues" list) grew.
    const stateAfterUnrelatedIssue = baseState({
      hasOwner: false,
      recentOpenIssues: [{ id: "issue_99", identifier: "ODIAA-99", title: "Unrelated new issue" }],
    });

    const second = await runPolicy(
      {
        policy: issueTriagePolicy,
        state: stateAfterUnrelatedIssue,
        config,
        companyId: "company_1",
        issueId: "issue_1",
        priorStateHash,
      },
      { client, db, apply: { log: vi.fn() }, suggest: { log: vi.fn() } },
    );
    expect(second).toEqual({ outcome: "skipped", reason: "pre-filter" });
  });
});
