import { describe, expect, it } from "vitest";
import type { LedgerDb } from "../src/ledger/db.js";
import { createFakeDb } from "./helpers/fake-db.js";
import {
  beginDecision,
  completeDecision,
  getDailyDecisionStats,
  getDecisionById,
  getLatestDecision,
  getModeSplit,
  getPolicyAggregate,
  listDecisionHistory,
  listLatestDecisionsByPolicy,
} from "../src/ledger/decisions.js";
import { getFeedbackSummary, listFeedbackForDecisions, recordFeedback } from "../src/ledger/feedback.js";
import { acquireLease, type LeaseState } from "../src/ledger/leases.js";

describe("ledger/decisions", () => {
  it("writes the audit row before the result is known, then completes it", async () => {
    const db = createFakeDb();
    const id = await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });

    const beforeComplete = await getLatestDecision(db, "company_1", "issue_1");
    expect(beforeComplete?.outcome).toBe("observed");
    expect(beforeComplete?.stateHash).toBe("");

    await completeDecision(db, id, {
      stateHash: "abc123",
      answers: { pong: { type: "noul", noul: 0.9 } },
      confidence: 0.9,
      margin: 0.4,
      latencyMs: 120,
      usage: { input_tokens: 10, output_tokens: 5 },
      costUsd: 0.0001,
      outcome: "observed",
      reason: "noul-above-threshold",
    });

    const after = await getLatestDecision(db, "company_1", "issue_1");
    expect(after?.stateHash).toBe("abc123");
    expect(after?.confidence).toBe(0.9);
    expect(after?.answers).toEqual({ pong: { type: "noul", noul: 0.9 } });
  });

  it("never persists free text or raw state — only policy, hash, and outcome fields", async () => {
    const db = createFakeDb();
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
      stateHash: "abc123",
      answers: { pong: { type: "noul", noul: 0.9 } },
      confidence: 0.9,
      margin: 0.4,
      latencyMs: 120,
      usage: { input_tokens: 10, output_tokens: 5 },
      costUsd: 0.0001,
      outcome: "observed",
      reason: "noul-above-threshold",
    });

    const row = await getLatestDecision(db, "company_1", "issue_1");
    expect(Object.keys(row ?? {})).not.toContain("state");
    expect(Object.keys(row ?? {})).not.toContain("rawState");
  });

  it("aggregates outcome counts per company and policy", async () => {
    const db = createFakeDb();
    for (const outcome of ["observed", "observed", "error"] as const) {
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
        answers: {},
        confidence: null,
        margin: null,
        latencyMs: 10,
        usage: { input_tokens: 1, output_tokens: 1 },
        costUsd: 0,
        outcome,
        reason: null,
      });
    }

    const aggregate = await getPolicyAggregate(db, "company_1", "ping");
    expect(aggregate.decisionCount).toBe(3);
    expect(aggregate.outcomeBreakdown).toEqual({ observed: 2, error: 1 });
  });

  it("never returns another company's decisions for the same issue id", async () => {
    const db = createFakeDb();
    await beginDecision(db, {
      companyId: "company_1",
      issueId: "shared_issue",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });
    await beginDecision(db, {
      companyId: "company_2",
      issueId: "shared_issue",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });

    const latestForCompany1 = await getLatestDecision(db, "company_1", "shared_issue");
    expect(latestForCompany1?.companyId).toBe("company_1");

    const historyForCompany2 = await listDecisionHistory(db, "company_2", "shared_issue");
    expect(historyForCompany2).toHaveLength(1);
    expect(historyForCompany2[0]?.companyId).toBe("company_2");

    const latestForUnrelatedCompany = await getLatestDecision(db, "company_3", "shared_issue");
    expect(latestForUnrelatedCompany).toBeNull();
  });

  it("never returns another company's decision by id", async () => {
    const db = createFakeDb();
    const id = await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });

    expect((await getDecisionById(db, "company_1", id))?.id).toBe(id);
    expect(await getDecisionById(db, "company_2", id)).toBeNull();
  });

  it("returns only the latest decision per policy for an issue", async () => {
    const db = createFakeDb();
    const olderPing = await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newerPing = await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });
    await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "other-policy",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });

    const latest = await listLatestDecisionsByPolicy(db, "company_1", "issue_1");
    expect(latest).toHaveLength(2);
    const pingDecision = latest.find((d) => d.policy === "ping");
    expect(pingDecision?.id).toBe(newerPing);
    expect(pingDecision?.id).not.toBe(olderPing);
  });

  it("buckets decisions per day and sums cost, scoped to company and window", async () => {
    const db = createFakeDb();
    await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });
    await beginDecision(db, {
      companyId: "company_2",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });

    const stats = await getDailyDecisionStats(db, "company_1", "1970-01-01T00:00:00.000Z");
    expect(stats).toHaveLength(1);
    expect(stats[0]?.decisionCount).toBe(1);

    const future = await getDailyDecisionStats(db, "company_1", "2999-01-01T00:00:00.000Z");
    expect(future).toHaveLength(0);
  });

  it("splits decisions by mode, scoped to company", async () => {
    const db = createFakeDb();
    await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });
    await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_2",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "enforce",
    });

    const split = await getModeSplit(db, "company_1");
    expect(split).toEqual({ shadow: 1, suggest: 0, enforce: 1 });
  });

  it("caps listDecisionHistory's limit regardless of what the caller requests", async () => {
    const inner = createFakeDb();
    const queriedLimits: unknown[] = [];
    const db: LedgerDb = {
      namespace: inner.namespace,
      execute: inner.execute.bind(inner),
      query: (sql, params = []) => {
        if (sql.includes("LIMIT $3")) queriedLimits.push(params[2]);
        return inner.query(sql, params);
      },
    };

    await listDecisionHistory(db, "company_1", "issue_1", 100_000);

    expect(queriedLimits).toEqual([100]);
  });
});

describe("ledger/feedback", () => {
  it("records feedback against a decision", async () => {
    const db = createFakeDb();
    const id = await recordFeedback(db, { decisionId: "decision_1", userId: "user_1", verdict: "accept" });
    expect(id).toBeTruthy();
  });

  it("lists feedback for a set of decision ids, empty array short-circuits with no query", async () => {
    const db = createFakeDb();
    await recordFeedback(db, { decisionId: "decision_1", userId: "user_1", verdict: "accept" });
    await recordFeedback(db, { decisionId: "decision_2", userId: "user_1", verdict: "override" });

    expect(await listFeedbackForDecisions(db, [])).toEqual([]);

    const rows = await listFeedbackForDecisions(db, ["decision_1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decisionId).toBe("decision_1");
    expect(rows[0]?.verdict).toBe("accept");
  });

  it("summarizes agreement rate scoped to a company via the decisions join, excluding other companies", async () => {
    const db = createFakeDb();
    const ownDecision = await beginDecision(db, {
      companyId: "company_1",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });
    const otherCompanyDecision = await beginDecision(db, {
      companyId: "company_2",
      issueId: "issue_1",
      policy: "ping",
      policyVersion: "1.0.0",
      questionVersion: "1.0.0",
      model: "jev-1.13.0",
      mode: "shadow",
    });
    await recordFeedback(db, { decisionId: ownDecision, userId: "user_1", verdict: "accept" });
    await recordFeedback(db, { decisionId: ownDecision, userId: "user_1", verdict: "override" });
    await recordFeedback(db, { decisionId: otherCompanyDecision, userId: "user_2", verdict: "override" });

    const summary = await getFeedbackSummary(db, "company_1");
    expect(summary).toEqual({ total: 2, accept: 1, override: 1, agreementRate: 0.5 });
  });

  it("reports a null agreement rate when there is no feedback yet", async () => {
    const db = createFakeDb();
    const summary = await getFeedbackSummary(db, "company_1");
    expect(summary).toEqual({ total: 0, accept: 0, override: 0, agreementRate: null });
  });
});

describe("ledger/leases", () => {
  function createFakeState(): LeaseState {
    const store = new Map<string, unknown>();
    const keyOf = (input: { namespace: string; stateKey: string }) => `${input.namespace}:${input.stateKey}`;
    return {
      async get(input) {
        return store.get(keyOf(input)) ?? null;
      },
      async set(input, value) {
        store.set(keyOf(input), value);
      },
    };
  }

  it("acquires a lease once per event id and rejects a redelivery within the TTL", async () => {
    const state = createFakeState();
    let now = 1_000;
    const clock = () => now;

    expect(await acquireLease(state, "event_1", 1_000, clock)).toBe(true);
    expect(await acquireLease(state, "event_1", 1_000, clock)).toBe(false);

    now += 2_000;
    expect(await acquireLease(state, "event_1", 1_000, clock)).toBe(true);
  });
});
