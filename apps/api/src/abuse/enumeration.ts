import type { AbuseRepo, RestrictionLevel } from '@imei-check/core';

/**
 * Enumeration detection that stores no IMEIs.
 *
 * IMEI enumeration is the headline threat here, because every paid call spends our money: someone
 * sweeping a TAC range can drain a balance in minutes, and the answers tell a thief which of their
 * haul is flagged yet.
 *
 * The obvious defence -- remember which IMEIs a key has asked about -- would require storing the
 * numbers we promised never to store. So instead we store a **bucket**: the TAC, plus the first
 * three digits of the serial portion. That is 1000 buckets per TAC.
 *
 *   A sweep lights up as "touched 900 of 1000 buckets under one TAC within an hour",
 *   which cannot happen legitimately.
 *
 * A TAC is a model, not a person, and three digits of serial identifies nobody. The signal
 * survives; the personal data never exists.
 */

const TAC_LENGTH = 8;
const BUCKET_DIGITS = 3;
export const BUCKETS_PER_TAC = 1000;

/** The ladder. Each rung costs the tenant more, so the cheap rungs come first. */
export const LADDER: readonly RestrictionLevel[] = [
  'none',
  'throttled',
  'cache_only',
  'no_paid',
  'suspended',
];

export interface EnumerationPolicy {
  readonly windowMs: number;
  /** Distinct buckets under ONE TAC within the window, per rung. */
  readonly throttleAt: number;
  readonly cacheOnlyAt: number;
  readonly noPaidAt: number;
  readonly suspendAt: number;
}

/**
 * Thresholds.
 *
 * Deliberately generous at the bottom: a phone shop checking a pallet of the same model is a good
 * customer doing something legitimate, and 120 distinct handsets of one model in an hour is a real
 * business. The ladder only bites well past that, and its most important rung is `cache_only` --
 * which costs us nothing, still answers the caller, and so makes a false positive nearly free for
 * both sides. Suspension is last because it is the only rung that loses revenue.
 */
export const DEFAULT_POLICY: EnumerationPolicy = {
  windowMs: 60 * 60 * 1000,
  throttleAt: 120,
  cacheOnlyAt: 300,
  noPaidAt: 600,
  suspendAt: 900,
};

export function bucketOf(imeiDigits: string): number {
  const serial = imeiDigits.slice(TAC_LENGTH, TAC_LENGTH + BUCKET_DIGITS);
  const parsed = Number.parseInt(serial, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function windowStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

export function levelFor(distinctBuckets: number, policy: EnumerationPolicy): RestrictionLevel {
  if (distinctBuckets >= policy.suspendAt) return 'suspended';
  if (distinctBuckets >= policy.noPaidAt) return 'no_paid';
  if (distinctBuckets >= policy.cacheOnlyAt) return 'cache_only';
  if (distinctBuckets >= policy.throttleAt) return 'throttled';
  return 'none';
}

export function isMoreSevere(a: RestrictionLevel, b: RestrictionLevel): boolean {
  return LADDER.indexOf(a) > LADDER.indexOf(b);
}

export class EnumerationGuard {
  constructor(
    private readonly repo: AbuseRepo,
    private readonly policy: EnumerationPolicy = DEFAULT_POLICY,
    private readonly onLadder?: (level: RestrictionLevel) => void,
  ) {}

  /**
   * Records one lookup and returns the level now in force.
   *
   * Recorded BEFORE the providers run, so the sweep that trips the threshold is the one that gets
   * stopped rather than the one after it.
   */
  async observe(args: {
    tenantId: string;
    tac: string;
    imeiDigits: string;
    now: Date;
  }): Promise<{ level: RestrictionLevel; distinctBuckets: number }> {
    const start = windowStart(args.now, this.policy.windowMs);
    await this.repo.record(args.tenantId, args.tac, bucketOf(args.imeiDigits), start);

    const distinctBuckets = await this.repo.distinctBuckets(args.tenantId, args.tac, start);
    const computed = levelFor(distinctBuckets, this.policy);

    const existing = await this.repo.restriction(args.tenantId);
    // An operator-applied restriction is never relaxed by this code path; it only ratchets up.
    // Automatic de-escalation is a deliberate human decision, because the alternative is that a
    // sweeper waits an hour and resumes.
    if (isMoreSevere(computed, existing.level)) {
      await this.repo.restrict(
        args.tenantId,
        computed,
        `${distinctBuckets} distinct serial buckets under TAC ${args.tac} within the window`,
      );
      this.onLadder?.(computed);
      return { level: computed, distinctBuckets };
    }
    return { level: existing.level, distinctBuckets };
  }
}
