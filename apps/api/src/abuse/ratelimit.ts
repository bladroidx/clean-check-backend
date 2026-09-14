/**
 * Per-key token bucket.
 *
 * In-process on purpose for now, with the limitation stated rather than hidden: with N replicas a
 * caller gets N times the limit. That is acceptable for the free tier (whose real constraint is
 * the licensing posture on `/v1/tac/:tac`, not load) and NOT acceptable as the only control on the
 * paid path -- which is why prepaid credits, not this bucket, are the hard ceiling on spend.
 *
 * The TAC endpoint's limit is part of the licensing position, not abuse control: an unlimited
 * single-lookup endpoint is a bulk export with extra steps, and someone will reconstruct the
 * compilation through it (ADR-0005).
 */

export interface BucketConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export const LIMITS = {
  /** 60/min sustained. Hard, because it is a licensing control. */
  tacLookup: { capacity: 60, refillPerSecond: 1 } satisfies BucketConfig,
  /** The free offline validator: generous, it costs us nothing but CPU. */
  validate: { capacity: 120, refillPerSecond: 2 } satisfies BucketConfig,
  /** Paid checks. Credits are the real ceiling; this only smooths bursts. */
  checks: { capacity: 30, refillPerSecond: 0.5 } satisfies BucketConfig,
} as const;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, config: BucketConfig, cost = 1): RateDecision {
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: config.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    }

    const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(config.capacity, bucket.tokens + elapsedSeconds * config.refillPerSecond);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens < cost) {
      const deficit = cost - bucket.tokens;
      return {
        allowed: false,
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: Math.ceil(deficit / config.refillPerSecond),
      };
    }
    bucket.tokens -= cost;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  /** Bounded memory: a limiter that remembers every key that ever called is a slow leak. */
  sweep(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefillMs < cutoff) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * How many paid checks one tenant may have in flight at once.
 *
 * The token bucket smooths a burst over time; it does nothing about depth. A client retry loop can
 * sit inside the rate limit and still hold a hundred checks open simultaneously. Credits remain
 * the hard ceiling on spend -- this is the ceiling on how fast that spend can be drawn down, and
 * on how much of a supplier's rate limit one tenant can occupy before every other tenant starts
 * reading `unavailable` through no fault of their own.
 *
 * Not a connection-pool control: `runCheck` does not hold a connection across the supplier call,
 * only across the short reserve and settle transactions, so this number and the pool's `max` are
 * independent. If that ever stops being true they have to be reasoned about together.
 */
export const MAX_CONCURRENT_PAID_CHECKS = 8;

/**
 * Per-tenant in-flight counter.
 *
 * In-process, with the same caveat as the token bucket: N replicas means N times the depth. That
 * is a real limitation and it is still worth having, because the failure it prevents -- one tenant
 * exhausting the pool for everybody -- is per-process in the first place.
 *
 * Unlike the bucket this needs no sweep: a key is deleted when its count reaches zero, so the map
 * holds only tenants with work actually running.
 */
export class ConcurrencyGate {
  private readonly inFlight = new Map<string, number>();

  tryAcquire(key: string, limit: number): boolean {
    const current = this.inFlight.get(key) ?? 0;
    if (current >= limit) return false;
    this.inFlight.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.inFlight.get(key) ?? 0;
    if (current <= 1) this.inFlight.delete(key);
    else this.inFlight.set(key, current - 1);
  }

  inFlightFor(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }

  get size(): number {
    return this.inFlight.size;
  }
}
