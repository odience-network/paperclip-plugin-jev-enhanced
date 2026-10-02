/** The slice of `ctx.db` the ledger depends on. Declared locally (instead of
 * importing the SDK's `PluginDatabaseClient`) so ledger functions can be unit
 * tested with a plain fake — the real test harness always returns `[]` from
 * `query()` and can't be seeded. */
export interface LedgerDb {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

export function tableName(db: LedgerDb, table: "jev_decisions" | "jev_feedback"): string {
  return `${db.namespace}.${table}`;
}
