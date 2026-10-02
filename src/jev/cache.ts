import type { JevAskResult } from "./types.js";

export interface JevCacheEntry {
  result: JevAskResult;
  cachedAt: number;
}

/** Injectable so tests can assert on cache hits/misses without timing games. */
export interface JevCache {
  get(key: string): JevCacheEntry | undefined;
  set(key: string, entry: JevCacheEntry): void;
}

export interface InMemoryJevCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Process-lifetime LRU cache keyed by policy + model version + canonical
 * state hash. Good enough for a single worker process; a future task can
 * swap this for a `ctx.state`-backed implementation without touching callers. */
export function createInMemoryJevCache(options: InMemoryJevCacheOptions = {}): JevCache {
  const maxEntries = options.maxEntries ?? 500;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const store = new Map<string, JevCacheEntry>();

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
  modelVersion: string;
  stateHash: string;
  questionsHash: string;
}): string {
  return `${input.policy}:${input.modelVersion}:${input.stateHash}:${input.questionsHash}`;
}
