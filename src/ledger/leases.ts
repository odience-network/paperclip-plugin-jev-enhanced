/** Minimal shape of `ctx.state` leases depend on, mirroring `PluginStateLike`
 * in `src/jev/budget.ts` so this module doesn't need to import SDK types. */
export interface LeaseState {
  get(input: { scopeKind: "instance"; namespace: string; stateKey: string }): Promise<unknown>;
  set(input: { scopeKind: "instance"; namespace: string; stateKey: string }, value: unknown): Promise<void>;
}

const LEASE_NAMESPACE = "jev-lease";
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

interface LeaseRecord {
  expiresAt: number;
}

/**
 * `ctx.state` has no native TTL, so a lease is a value with an `expiresAt`
 * that an expired read treats as absent. Keyed by the triggering event id so
 * a redelivered event cannot double-evaluate (and double-bill) a policy.
 *
 * Returns `true` if the lease was acquired (caller should proceed), `false`
 * if an unexpired lease already exists (caller should skip as a duplicate).
 */
export async function acquireLease(
  state: LeaseState,
  eventId: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
  now: () => number = Date.now,
): Promise<boolean> {
  const key = { scopeKind: "instance" as const, namespace: LEASE_NAMESPACE, stateKey: eventId };
  const existing = (await state.get(key)) as LeaseRecord | null;
  const nowMs = now();
  if (existing && existing.expiresAt > nowMs) {
    return false;
  }
  await state.set(key, { expiresAt: nowMs + ttlMs } satisfies LeaseRecord);
  return true;
}
