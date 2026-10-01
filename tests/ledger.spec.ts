import { describe, expect, it } from "vitest";
import type { LedgerDb } from "../src/ledger/db.js";
import { beginDecision, completeDecision, getLatestDecision, getPolicyAggregate } from "../src/ledger/decisions.js";
import { recordFeedback } from "../src/ledger/feedback.js";
import { acquireLease, type LeaseState } from "../src/ledger/leases.js";

/** A minimal in-memory `LedgerDb` that actually stores rows, since the real
 * SDK test harness always returns `[]` from `query()` and can't be seeded. */
function createFakeDb(): LedgerDb {
  const decisions: Record<string, unknown>[] = [];
  const feedback: Record<string, unknown>[] = [];

  return {
    namespace: "plugin_jev_test",
    async execute(sql, params = []) {
      if (sql.includes("INSERT INTO") && sql.includes("jev_decisions")) {
        const [id, companyId, issueId, runId, agentId, policy, policyVersion, questionVersion, model, stateHash, mode] = params;
        decisions.push({
          id,
          company_id: companyId,
          issue_id: issueId,
          run_id: runId,
          agent_id: agentId,
          policy,
          policy_version: policyVersion,
          question_version: questionVersion,
          model,
          state_hash: stateHash,
          answers: {},
          confidence: null,
          margin: null,
          latency_ms: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          cost_usd: 0,
          mode,
          outcome: "observed",
          reason: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { rowCount: 1 };
      }
      if (sql.includes("UPDATE") && sql.includes("jev_decisions")) {
        const [id, stateHash, answers, confidence, margin, latencyMs, usage, costUsd, outcome, reason] = params;
        const row = decisions.find((r) => r.id === id);
        if (row) {
          Object.assign(row, {
            state_hash: stateHash,
            answers: JSON.parse(answers as string),
            confidence,
            margin,
            latency_ms: latencyMs,
            usage: JSON.parse(usage as string),
            cost_usd: costUsd,
            outcome,
            reason,
            updated_at: new Date().toISOString(),
          });
        }
        return { rowCount: row ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO") && sql.includes("jev_feedback")) {
        const [id, decisionId, userId, agentId, verdict, note] = params;
        feedback.push({ id, decision_id: decisionId, user_id: userId, agent_id: agentId, verdict, note });
        return { rowCount: 1 };
      }
      throw new Error(`Unhandled SQL in fake db: ${sql}`);
    },
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes("WHERE issue_id") && sql.includes("ORDER BY created_at DESC LIMIT 1")) {
        const [issueId] = params;
        return decisions.filter((r) => r.issue_id === issueId).slice(0, 1) as T[];
      }
      if (sql.includes("WHERE issue_id") && sql.includes("LIMIT $2")) {
        const [issueId, limit] = params as [string, number];
        return decisions.filter((r) => r.issue_id === issueId).slice(0, limit) as T[];
      }
      if (sql.includes("avg(confidence)")) {
        const [companyId, policy] = params as [string, string];
        const matching = decisions.filter((r) => r.company_id === companyId && r.policy === policy);
        return [
          {
            decision_count: String(matching.length),
            avg_confidence: matching.length ? String(matching[0].confidence ?? 0) : null,
            avg_latency_ms: matching.length ? String(matching[0].latency_ms ?? 0) : null,
            total_cost_usd: String(matching.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0)),
          },
        ] as T[];
      }
      if (sql.includes("GROUP BY outcome")) {
        const [companyId, policy] = params as [string, string];
        const matching = decisions.filter((r) => r.company_id === companyId && r.policy === policy);
        const counts = new Map<string, number>();
        for (const row of matching) {
          const outcome = row.outcome as string;
          counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
        }
        return [...counts.entries()].map(([outcome, count]) => ({ outcome, count: String(count) })) as T[];
      }
      throw new Error(`Unhandled SQL in fake db: ${sql}`);
    },
  };
}

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

    const beforeComplete = await getLatestDecision(db, "issue_1");
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

    const after = await getLatestDecision(db, "issue_1");
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

    const row = await getLatestDecision(db, "issue_1");
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
});

describe("ledger/feedback", () => {
  it("records feedback against a decision", async () => {
    const db = createFakeDb();
    const id = await recordFeedback(db, { decisionId: "decision_1", userId: "user_1", verdict: "accept" });
    expect(id).toBeTruthy();
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
