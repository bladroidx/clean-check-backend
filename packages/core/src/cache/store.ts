import type { Capability, Coverage } from '@imei-check/contract';
import { capabilityOf, type CanonicalField, type FieldValue } from '@imei-check/providers';
import type { CacheRepo, CacheRow } from '../db/types.js';
import { expiryFor } from './ttl.js';

/**
 * Field-level cache, global across tenants.
 *
 * Global because device reputation is a property of the device, not of who asked: a per-tenant
 * cache multiplies supplier spend by the number of tenants asking about the same handset for no
 * gain in correctness. Cache-hit rate is essentially the gross margin of this business.
 *
 * The key is the INTERNAL hash -- `HMAC(SERVER_PEPPER, digits)` -- never the tenant-facing one,
 * which is salted per tenant and so could not collide across tenants even when it should.
 */

export interface CachedField {
  readonly field: CanonicalField;
  readonly value: string;
  readonly rawLabel: string | undefined;
  readonly coverage: Coverage;
  readonly checkedAt: Date;
  readonly ageSeconds: number;
  readonly ttlSeconds: number;
}

export function cacheKey(imeiHash: string, field: CanonicalField): string {
  return `${imeiHash}:${field}`;
}

export class FieldCache {
  constructor(private readonly repo: CacheRepo) {}

  /**
   * Reads every field belonging to a capability.
   *
   * A partial hit is not a hit: if a capability needs a deciding field and it has expired, the
   * capability must be re-bought. Serving the stale half beside a fresh half would produce a
   * section whose `checked_at` is true of some of it and false of the rest.
   */
  async read(args: {
    imeiHash: string;
    capability: Capability;
    fields: readonly CanonicalField[];
    now: Date;
    maxAgeSeconds?: number;
  }): Promise<CachedField[]> {
    const out: CachedField[] = [];
    for (const field of args.fields) {
      if (capabilityOf(field) !== args.capability) continue;
      const row = await this.repo.get(cacheKey(args.imeiHash, field));
      if (row === undefined) continue;
      if (row.expiresAt <= args.now) continue;

      const ageMs = Math.max(0, args.now.getTime() - row.checkedAt.getTime());
      const ageSeconds = Math.floor(ageMs / 1000);

      if (args.maxAgeSeconds !== undefined) {
        // Zero is an ABSOLUTE bypass, handled separately rather than as `age > 0`.
        //
        // Ages are reported floored to whole seconds, so an entry written 400ms ago has an age of
        // 0 and would satisfy `age > 0` -- meaning `max_age_seconds: 0` silently served a cache
        // hit for the first second of every entry's life. That is exactly the case a caller uses
        // it for: re-checking immediately after a seller signs out of iCloud while they watch.
        if (args.maxAgeSeconds === 0) continue;
        // Compared in milliseconds so the boundary is the real one, not the rounded one.
        if (ageMs > args.maxAgeSeconds * 1000) continue;
      }

      const ttlSeconds = Math.max(
        0,
        Math.floor((row.expiresAt.getTime() - row.checkedAt.getTime()) / 1000),
      );
      out.push({
        field: row.field as CanonicalField,
        value: row.value,
        rawLabel: row.rawLabel,
        coverage: row.coverage,
        checkedAt: row.checkedAt,
        ageSeconds,
        ttlSeconds,
      });
    }
    return out;
  }

  async write(args: {
    imeiHash: string;
    fields: readonly FieldValue[];
    coverage: Coverage;
    providerId: string;
    checkedAt: Date;
  }): Promise<void> {
    for (const field of args.fields) {
      const expiresAt = expiryFor(field.field, field.value, args.checkedAt);
      // A field with no TTL rule, or an unrecognised value, is deliberately not written. Caching
      // a value we could not interpret would make one lexicon miss permanent.
      if (expiresAt === undefined) continue;

      const row: CacheRow = {
        cacheKey: cacheKey(args.imeiHash, field.field),
        capability: capabilityOf(field.field),
        field: field.field,
        value: field.value,
        rawLabel: field.rawLabel,
        coverage: args.coverage,
        providerId: args.providerId,
        checkedAt: args.checkedAt,
        expiresAt,
      };
      await this.repo.put(row);
    }
  }
}

/** Cached answers cost 20% of list. The global cache is where the margin comes from. */
export const CACHE_HIT_PRICE_FACTOR = 0.2;

export function cachedPrice(listCredits: number): number {
  // Rounded UP so a 1-credit capability never becomes free by rounding -- a cache hit still costs
  // us a database round trip, and a free tier that appears by accident is not a pricing decision.
  return Math.max(1, Math.ceil(listCredits * CACHE_HIT_PRICE_FACTOR));
}
