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
