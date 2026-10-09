/**
 * Per-company token buckets for the `guard/evaluate` route: one bucket
 * capping requests/second, one capping (estimated) tokens/second. Guards
 * against the route itself becoming a DoS vector — a hostile or buggy agent
 * firing PreToolUse calls in a tight loop must hit this limit long before it
 * could exhaust the daily Jev token budget or starve other companies' calls
 * on a shared worker (see docs/SECURITY.md "Rate limits").
 *
 * In-memory and per-worker-process; acceptable because this bounds load on
 * *this* worker's outbound Jev calls, not a cross-process invariant.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSeconds = (nowMs - this.lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = nowMs;
  }

  /** Attempts to spend `cost` tokens. Returns `true` and deducts on success,
   * `false` (no deduction) if insufficient tokens are available. */
  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export interface GuardRateLimiter {
  /** Returns `true` if this call may proceed, `false` if it is rate-limited. */
  tryConsume(companyId: string, estimatedTokens: number): boolean;
}

export function createGuardRateLimiter(requestsPerSecond: number, tokensPerSecond: number): GuardRateLimiter {
  const requestBuckets = new Map<string, TokenBucket>();
  const tokenBuckets = new Map<string, TokenBucket>();

  function bucketFor(map: Map<string, TokenBucket>, companyId: string, capacity: number, refillPerSecond: number): TokenBucket {
    let bucket = map.get(companyId);
    if (!bucket) {
      bucket = new TokenBucket(capacity, refillPerSecond);
      map.set(companyId, bucket);
    }
    return bucket;
  }

  return {
    tryConsume(companyId, estimatedTokens) {
      const requestBucket = bucketFor(requestBuckets, companyId, requestsPerSecond, requestsPerSecond);
      const tokenBucket = bucketFor(tokenBuckets, companyId, tokensPerSecond, tokensPerSecond);
      // Both buckets must have capacity. A call that passes the request
      // check but fails the token check still spends its request-bucket
      // token — intentional, since it still cost a dispatch and we want
      // tight retries to exhaust the request bucket too, not just the token one.
      if (!requestBucket.tryConsume(1)) return false;
      if (!tokenBucket.tryConsume(Math.max(1, estimatedTokens))) return false;
      return true;
    },
  };
}
