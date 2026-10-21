import type { LedgerDb } from "../../src/ledger/db.js";

/** A minimal in-memory `LedgerDb` that actually stores rows, since the real
 * SDK test harness always returns `[]` from `query()` and can't be seeded. */
export function createFakeDb(): LedgerDb {
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
        feedback.push({
          id,
          decision_id: decisionId,
          user_id: userId,
          agent_id: agentId,
          verdict,
          note,
          created_at: new Date().toISOString(),
        });
        return { rowCount: 1 };
      }
      throw new Error(`Unhandled SQL in fake db: ${sql}`);
    },
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes("company_id = $1 AND issue_id = $2") && sql.includes("ORDER BY created_at DESC LIMIT 1")) {
        const [companyId, issueId] = params;
        return decisions.filter((r) => r.company_id === companyId && r.issue_id === issueId).slice(0, 1) as T[];
      }
      if (sql.includes("company_id = $1 AND issue_id = $2") && sql.includes("LIMIT $3")) {
        const [companyId, issueId, limit] = params as [string, string, number];
        return decisions
          .filter((r) => r.company_id === companyId && r.issue_id === issueId)
          .slice(0, limit) as T[];
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
      if (sql.includes("company_id = $1 AND id = $2")) {
        const [companyId, id] = params as [string, string];
        return decisions.filter((r) => r.company_id === companyId && r.id === id).slice(0, 1) as T[];
      }
      if (sql.includes("DISTINCT ON (policy)")) {
        const [companyId, issueId] = params as [string, string];
        const matching = decisions
          .filter((r) => r.company_id === companyId && r.issue_id === issueId)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const seen = new Set<string>();
        const latestByPolicy: Record<string, unknown>[] = [];
        for (const row of matching) {
          const policy = row.policy as string;
          if (seen.has(policy)) continue;
          seen.add(policy);
          latestByPolicy.push(row);
        }
        return latestByPolicy as T[];
      }
      if (sql.includes("date_trunc('day'")) {
        const [companyId, sinceIso] = params as [string, string];
        const matching = decisions.filter(
          (r) => r.company_id === companyId && String(r.created_at) >= sinceIso,
        );
        const byDay = new Map<string, { count: number; cost: number }>();
        for (const row of matching) {
          const day = String(row.created_at).slice(0, 10);
          const bucket = byDay.get(day) ?? { count: 0, cost: 0 };
          bucket.count += 1;
          bucket.cost += Number(row.cost_usd ?? 0);
          byDay.set(day, bucket);
        }
        return [...byDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, { count, cost }]) => ({
            day,
            decision_count: String(count),
            total_cost_usd: String(cost),
          })) as T[];
      }
      if (sql.includes("GROUP BY mode")) {
        const [companyId] = params as [string];
        const matching = decisions.filter((r) => r.company_id === companyId);
        const counts = new Map<string, number>();
        for (const row of matching) {
          const mode = row.mode as string;
          counts.set(mode, (counts.get(mode) ?? 0) + 1);
        }
        return [...counts.entries()].map(([mode, count]) => ({ mode, count: String(count) })) as T[];
      }
      if (sql.includes("decision_id = ANY($1)")) {
        const [decisionIds] = params as [string[]];
        return feedback
          .filter((f) => decisionIds.includes(f.decision_id as string))
          .map((f) => ({ ...f, created_at: (f.created_at as string | undefined) ?? new Date().toISOString() })) as T[];
      }
      if (sql.includes("JOIN") && sql.includes("jev_feedback") && sql.includes("GROUP BY f.verdict")) {
        const [companyId] = params as [string];
        const companyDecisionIds = new Set(
          decisions.filter((r) => r.company_id === companyId).map((r) => r.id as string),
        );
        const matching = feedback.filter((f) => companyDecisionIds.has(f.decision_id as string));
        const counts = new Map<string, number>();
        for (const row of matching) {
          const verdict = row.verdict as string;
          counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
        }
        return [...counts.entries()].map(([verdict, count]) => ({ verdict, count: String(count) })) as T[];
      }
      throw new Error(`Unhandled SQL in fake db: ${sql}`);
    },
  };
}
