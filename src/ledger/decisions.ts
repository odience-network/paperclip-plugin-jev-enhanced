import { randomUUID } from "node:crypto";
import type { PolicyMode } from "../config.js";
import { type LedgerDb, tableName } from "./db.js";

export type DecisionOutcome = "observed" | "suggested" | "applied" | "skipped" | "blocked" | "error";

export interface DecisionUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface BeginDecisionInput {
  id?: string;
  companyId: string;
  issueId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  policy: string;
  policyVersion: string;
  questionVersion: string;
  model: string;
  /** Usually unknown at audit-row time (the client computes it as part of the
   * provider call); `completeDecision` fills in the real value. */
  stateHash?: string;
  mode: PolicyMode;
}

export interface CompleteDecisionInput {
  stateHash: string;
  answers: Record<string, unknown>;
  confidence?: number | null;
  margin?: number | null;
  latencyMs: number;
  usage: DecisionUsage;
  costUsd: number;
  outcome: DecisionOutcome;
  reason?: string | null;
}

export interface DecisionRow {
  id: string;
  companyId: string;
  issueId: string | null;
  runId: string | null;
  agentId: string | null;
  policy: string;
  policyVersion: string;
  questionVersion: string;
  model: string;
  stateHash: string;
  answers: Record<string, unknown>;
  confidence: number | null;
  margin: number | null;
  latencyMs: number | null;
  usage: DecisionUsage;
  costUsd: number;
  mode: PolicyMode;
  outcome: DecisionOutcome;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DecisionDbRow {
  id: string;
  company_id: string;
  issue_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  policy: string;
  policy_version: string;
  question_version: string;
  model: string;
  state_hash: string;
  answers: Record<string, unknown>;
  confidence: number | null;
  margin: number | null;
  latency_ms: number | null;
  usage: DecisionUsage;
  cost_usd: string | number;
  mode: PolicyMode;
  outcome: DecisionOutcome;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function fromDbRow(row: DecisionDbRow): DecisionRow {
  return {
    id: row.id,
    companyId: row.company_id,
    issueId: row.issue_id,
    runId: row.run_id,
    agentId: row.agent_id,
    policy: row.policy,
    policyVersion: row.policy_version,
    questionVersion: row.question_version,
    model: row.model,
    stateHash: row.state_hash,
    answers: row.answers,
    confidence: row.confidence,
    margin: row.margin,
    latencyMs: row.latency_ms,
    usage: row.usage,
    costUsd: typeof row.cost_usd === "string" ? Number.parseFloat(row.cost_usd) : row.cost_usd,
    mode: row.mode,
    outcome: row.outcome,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Writes the decision + audit row BEFORE the provider call is made, so every
 * attempted evaluation is auditable even if the provider call fails or the
 * process crashes mid-flight. Call `completeDecision` once the outcome (or
 * failure) is known.
 */
export async function beginDecision(db: LedgerDb, input: BeginDecisionInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await db.execute(
    `INSERT INTO ${tableName(db, "jev_decisions")}
       (id, company_id, issue_id, run_id, agent_id, policy, policy_version, question_version, model, state_hash, mode, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'observed')`,
    [
      id,
      input.companyId,
      input.issueId ?? null,
      input.runId ?? null,
      input.agentId ?? null,
      input.policy,
      input.policyVersion,
      input.questionVersion,
      input.model,
      input.stateHash ?? "",
      input.mode,
    ],
  );
  return id;
}

export async function completeDecision(db: LedgerDb, id: string, patch: CompleteDecisionInput): Promise<void> {
  await db.execute(
    `UPDATE ${tableName(db, "jev_decisions")}
     SET state_hash = $2,
         answers = $3::jsonb,
         confidence = $4,
         margin = $5,
         latency_ms = $6,
         usage = $7::jsonb,
         cost_usd = $8,
         outcome = $9,
         reason = $10,
         updated_at = now()
     WHERE id = $1`,
    [
      id,
      patch.stateHash,
      JSON.stringify(patch.answers),
      patch.confidence ?? null,
      patch.margin ?? null,
      patch.latencyMs,
      JSON.stringify(patch.usage),
      patch.costUsd,
      patch.outcome,
      patch.reason ?? null,
    ],
  );
}

/** Hard ceiling on `listDecisionHistory`'s `limit`, independent of what a
 * caller requests, so a single UI/API call can't force an unbounded scan. */
const MAX_DECISION_HISTORY_LIMIT = 100;

/**
 * `companyId` is required (not inferred from `issueId`) and is always part of
 * the `WHERE` clause: an `issueId` alone must never be enough to read another
 * company's decision rows.
 */
export async function getLatestDecision(db: LedgerDb, companyId: string, issueId: string): Promise<DecisionRow | null> {
  const rows = await db.query<DecisionDbRow>(
    `SELECT * FROM ${tableName(db, "jev_decisions")}
     WHERE company_id = $1 AND issue_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, issueId],
  );
  return rows[0] ? fromDbRow(rows[0]) : null;
}

export async function listDecisionHistory(
  db: LedgerDb,
  companyId: string,
  issueId: string,
  limit = 20,
): Promise<DecisionRow[]> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_DECISION_HISTORY_LIMIT));
  const rows = await db.query<DecisionDbRow>(
    `SELECT * FROM ${tableName(db, "jev_decisions")}
     WHERE company_id = $1 AND issue_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [companyId, issueId, boundedLimit],
  );
  return rows.map(fromDbRow);
}

export interface PolicyAggregate {
  policy: string;
  companyId: string;
  decisionCount: number;
  avgConfidence: number | null;
  avgLatencyMs: number | null;
  totalCostUsd: number;
  outcomeBreakdown: Record<string, number>;
}

interface AggregateDbRow {
  decision_count: string;
  avg_confidence: string | null;
  avg_latency_ms: string | null;
  total_cost_usd: string | null;
}

interface OutcomeCountRow {
  outcome: DecisionOutcome;
  count: string;
}

/** Aggregates for the T5 dashboard. Two queries (totals + outcome breakdown)
 * rather than one, so the breakdown doesn't require client-side pivoting. */
export async function getPolicyAggregate(db: LedgerDb, companyId: string, policy: string): Promise<PolicyAggregate> {
  const [totals] = await db.query<AggregateDbRow>(
    `SELECT count(*)::text AS decision_count,
            avg(confidence)::text AS avg_confidence,
            avg(latency_ms)::text AS avg_latency_ms,
            coalesce(sum(cost_usd), 0)::text AS total_cost_usd
     FROM ${tableName(db, "jev_decisions")}
     WHERE company_id = $1 AND policy = $2`,
    [companyId, policy],
  );
  const outcomeRows = await db.query<OutcomeCountRow>(
    `SELECT outcome, count(*)::text AS count
     FROM ${tableName(db, "jev_decisions")}
     WHERE company_id = $1 AND policy = $2
     GROUP BY outcome`,
    [companyId, policy],
  );

  return {
    policy,
    companyId,
    decisionCount: totals ? Number.parseInt(totals.decision_count, 10) : 0,
    avgConfidence: totals?.avg_confidence ? Number.parseFloat(totals.avg_confidence) : null,
    avgLatencyMs: totals?.avg_latency_ms ? Number.parseFloat(totals.avg_latency_ms) : null,
    totalCostUsd: totals?.total_cost_usd ? Number.parseFloat(totals.total_cost_usd) : 0,
    outcomeBreakdown: Object.fromEntries(outcomeRows.map((row) => [row.outcome, Number.parseInt(row.count, 10)])),
  };
}
