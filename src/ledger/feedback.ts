import { randomUUID } from "node:crypto";
import { type LedgerDb, tableName } from "./db.js";

export type FeedbackVerdict = "accept" | "override";

export interface RecordFeedbackInput {
  id?: string;
  decisionId: string;
  userId?: string | null;
  agentId?: string | null;
  verdict: FeedbackVerdict;
  note?: string | null;
}

export async function recordFeedback(db: LedgerDb, input: RecordFeedbackInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await db.execute(
    `INSERT INTO ${tableName(db, "jev_feedback")} (id, decision_id, user_id, agent_id, verdict, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.decisionId, input.userId ?? null, input.agentId ?? null, input.verdict, input.note ?? null],
  );
  return id;
}

export interface FeedbackRow {
  id: string;
  decisionId: string;
  userId: string | null;
  agentId: string | null;
  verdict: FeedbackVerdict;
  note: string | null;
  createdAt: string;
}

interface FeedbackDbRow {
  id: string;
  decision_id: string;
  user_id: string | null;
  agent_id: string | null;
  verdict: FeedbackVerdict;
  note: string | null;
  created_at: string;
}

function fromFeedbackDbRow(row: FeedbackDbRow): FeedbackRow {
  return {
    id: row.id,
    decisionId: row.decision_id,
    userId: row.user_id,
    agentId: row.agent_id,
    verdict: row.verdict,
    note: row.note,
    createdAt: row.created_at,
  };
}

/** Feedback rows for a set of decisions, so the issue detail tab can show
 * accept/override state inline with each decision it already fetched. */
export async function listFeedbackForDecisions(db: LedgerDb, decisionIds: string[]): Promise<FeedbackRow[]> {
  if (decisionIds.length === 0) return [];
  const rows = await db.query<FeedbackDbRow>(
    `SELECT * FROM ${tableName(db, "jev_feedback")}
     WHERE decision_id = ANY($1)
     ORDER BY created_at DESC`,
    [decisionIds],
  );
  return rows.map(fromFeedbackDbRow);
}

export interface FeedbackSummary {
  total: number;
  accept: number;
  override: number;
  /** `accept / total`, or `null` when there is no feedback yet — distinct
   * from `0`, which would mean "every piece of feedback was an override". */
  agreementRate: number | null;
}

interface FeedbackVerdictCountRow {
  verdict: FeedbackVerdict;
  count: string;
}

/** Agreement rate for the T5 dashboard widget. `jev_feedback` has no
 * `company_id` column, so scoping to a company requires joining back to
 * `jev_decisions` — the same tenant guard as every other ledger read. */
export async function getFeedbackSummary(db: LedgerDb, companyId: string): Promise<FeedbackSummary> {
  const rows = await db.query<FeedbackVerdictCountRow>(
    `SELECT f.verdict AS verdict, count(*)::text AS count
     FROM ${tableName(db, "jev_feedback")} f
     JOIN ${tableName(db, "jev_decisions")} d ON d.id = f.decision_id
     WHERE d.company_id = $1
     GROUP BY f.verdict`,
    [companyId],
  );
  const counts = { accept: 0, override: 0 };
  for (const row of rows) {
    counts[row.verdict] = Number.parseInt(row.count, 10);
  }
  const total = counts.accept + counts.override;
  return {
    total,
    accept: counts.accept,
    override: counts.override,
    agreementRate: total > 0 ? counts.accept / total : null,
  };
}
