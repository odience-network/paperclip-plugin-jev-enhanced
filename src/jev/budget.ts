export interface BudgetUsage {
  tokens: number;
  costUsd: number;
}

/** Injectable so the client can be unit tested without a real `ctx.state`. */
export interface BudgetStore {
  get(companyId: string, dateKey: string): Promise<BudgetUsage | null>;
  add(companyId: string, dateKey: string, delta: BudgetUsage): Promise<BudgetUsage>;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly companyId: string,
    public readonly dateKey: string,
    public readonly usage: BudgetUsage,
    public readonly limitTokens: number,
  ) {
    super(
      `Daily Jev token budget exceeded for company ${companyId} on ${dateKey}: ` +
        `${usage.tokens}/${limitTokens} tokens already used`,
    );
    this.name = "BudgetExceededError";
  }
}

export function utcDateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function createInMemoryBudgetStore(): BudgetStore {
  const store = new Map<string, BudgetUsage>();
  const keyOf = (companyId: string, dateKey: string) => `${companyId}:${dateKey}`;
  return {
    async get(companyId, dateKey) {
      return store.get(keyOf(companyId, dateKey)) ?? null;
    },
    async add(companyId, dateKey, delta) {
      const key = keyOf(companyId, dateKey);
      const prev = store.get(key) ?? { tokens: 0, costUsd: 0 };
      const next = { tokens: prev.tokens + delta.tokens, costUsd: prev.costUsd + delta.costUsd };
      store.set(key, next);
      return next;
    },
  };
}

/** Minimal shape of `ctx.state` this module depends on, so `src/worker.ts` can
 * pass the real plugin context without this module importing the SDK types. */
export interface PluginStateLike {
  get(input: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }): Promise<unknown>;
  set(input: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }, value: unknown): Promise<void>;
}

export function createPluginStateBudgetStore(state: PluginStateLike): BudgetStore {
  const scopeKeyFor = (companyId: string, dateKey: string) =>
    ({ scopeKind: "company" as const, scopeId: companyId, namespace: "jev-budget", stateKey: dateKey });

  return {
    async get(companyId, dateKey) {
      const value = await state.get(scopeKeyFor(companyId, dateKey));
      return (value as BudgetUsage | null) ?? null;
    },
    async add(companyId, dateKey, delta) {
      const key = scopeKeyFor(companyId, dateKey);
      const prev = ((await state.get(key)) as BudgetUsage | null) ?? { tokens: 0, costUsd: 0 };
      const next = { tokens: prev.tokens + delta.tokens, costUsd: prev.costUsd + delta.costUsd };
      await state.set(key, next);
      return next;
    },
  };
}
