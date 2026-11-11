import type { VerdictAskResult } from "./types.js";

export interface VerdictCacheEntry {
  result: VerdictAskResult;
  cachedAt: number;
}

/** Injectable so tests can assert on cache hits/misses without timing games. */
export interface VerdictCache {
  get(key: string): VerdictCacheEntry | undefined;
  set(key: string, entry: VerdictCacheEntry): void;
}

export interface InMemoryVerdictCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Process-lifetime LRU cache keyed by policy + provider + model version +
 * canonical state hash. Good enough for a single worker process; a future task can
 * swap this for a `ctx.state`-backed implementation without touching callers. */
export function createInMemoryVerdictCache(options: InMemoryVerdictCacheOptions = {}): VerdictCache {
  const maxEntries = options.maxEntries ?? 500;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const store = new Map<string, VerdictCacheEntry>();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (now() - entry.cachedAt > ttlMs) {
        store.delete(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, entry);
      return entry;
    },
    set(key, entry) {
      if (!store.has(key) && store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) store.delete(oldestKey);
      }
      store.set(key, entry);
    },
  };
}

export function cacheKeyFor(input: {
  policy: string;
  provider: string;
  modelVersion: string;
  stateHash: string;
  questionsHash: string;
}): string {
  return `${input.policy}:${input.provider}:${input.modelVersion}:${input.stateHash}:${input.questionsHash}`;
}
