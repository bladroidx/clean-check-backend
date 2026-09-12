import { describe, expect, it } from 'vitest';
import type { Coverage } from '@imei-check/contract';
import { MemoryRepositories } from '../src/db/memory.js';
import { FieldCache, cacheKey } from '../src/cache/store.js';
import { expiryFor, ttlFor } from '../src/cache/ttl.js';

/**
 * Cache TTLs, crossed from both sides.
 *
 * The asymmetry is the thing worth testing: `blacklist = clean` expires in an hour and
 * `blacklist = blocked` lasts a day, because a stale "blocked" costs a seller a sale and is
 * recoverable, while a stale "clean" helps sell a stolen handset and is not.
 */

const COVERAGE: Coverage = { registries: ['test'], caveats: [] };
const T0 = new Date('2026-09-13T12:00:00.000Z');

describe('the TTL table', () => {
  it('expires a clean blacklist in an hour and a blocked one in a day', () => {
    expect(ttlFor('blacklist.status', 'clean').seconds).toBe(3600);
    expect(ttlFor('blacklist.status', 'blocked').seconds).toBe(86_400);
  });

  it('never caches an unrecognised status', () => {
    // Caching a value we could not interpret would make one lexicon miss permanent.
    expect(ttlFor('blacklist.status', 'who_knows').seconds).toBe(0);
    expect(expiryFor('blacklist.status', 'who_knows', T0)).toBeUndefined();
  });

  it('gives activation lock 15 minutes, because it flips while a buyer watches', () => {
    expect(ttlFor('lock.activation.status', 'on').seconds).toBe(900);
  });

  it('treats immutable facts as permanent', () => {
    expect(ttlFor('warranty.purchase_date', 'x').seconds).toBe(Infinity);
    expect(ttlFor('identity.model', 'x').seconds).toBe(Infinity);
    const expiry = expiryFor('warranty.purchase_date', 'x', T0);
    expect(expiry?.getUTCFullYear()).toBe(T0.getUTCFullYear() + 100);
  });

  it('states an argument beside every rule', () => {
    // A TTL without its reasoning is a number someone will change on a hunch.
    expect(ttlFor('blacklist.status', 'clean').why.length).toBeGreaterThan(20);
  });
});

describe('the field cache', () => {
  async function cache() {
    const repos = new MemoryRepositories();
    return { repos, cache: new FieldCache(repos.cache) };
  }

  it('writes and reads back a field, reporting a truthful age', async () => {
    const { cache: c } = await cache();
    await c.write({
      imeiHash: 'h1',
      fields: [{ field: 'blacklist.status', value: 'clean' }],
      coverage: COVERAGE,
      providerId: 'alpha',
      checkedAt: T0,
    });

    const later = new Date(T0.getTime() + 600_000);
    const hits = await c.read({
      imeiHash: 'h1',
      capability: 'blacklist.gsma',
      fields: ['blacklist.status'],
      now: later,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.value).toBe('clean');
    expect(hits[0]?.ageSeconds).toBe(600);
    // The ORIGINAL checked_at, not now. Serving a cache hit that looks fresh is the one thing
    // this product cannot do.
    expect(hits[0]?.checkedAt).toEqual(T0);
  });

  it('misses one second past the TTL boundary and hits one second before it', async () => {
    const { cache: c } = await cache();
    await c.write({
      imeiHash: 'h1',
      fields: [{ field: 'blacklist.status', value: 'clean' }],
      coverage: COVERAGE,
      providerId: 'alpha',
      checkedAt: T0,
    });

    const justInside = new Date(T0.getTime() + 3599_000);
    const justOutside = new Date(T0.getTime() + 3601_000);

    expect(
      await c.read({ imeiHash: 'h1', capability: 'blacklist.gsma', fields: ['blacklist.status'], now: justInside }),
    ).toHaveLength(1);
    expect(
      await c.read({ imeiHash: 'h1', capability: 'blacklist.gsma', fields: ['blacklist.status'], now: justOutside }),
    ).toHaveLength(0);
  });

  /** Without this, the freshness promise in `coverage` is unfalsifiable. */
  it('max_age_seconds: 0 bypasses the cache entirely', async () => {
    const { cache: c } = await cache();
    await c.write({
      imeiHash: 'h1',
      fields: [{ field: 'blacklist.status', value: 'clean' }],
      coverage: COVERAGE,
      providerId: 'alpha',
      checkedAt: T0,
    });
    const hits = await c.read({
      imeiHash: 'h1',
      capability: 'blacklist.gsma',
      fields: ['blacklist.status'],
      now: new Date(T0.getTime() + 1000),
      maxAgeSeconds: 0,
    });
    expect(hits).toEqual([]);
  });

  it('does not write a field whose value has no TTL rule', async () => {
    const { repos, cache: c } = await cache();
    await c.write({
      imeiHash: 'h1',
      fields: [{ field: 'blacklist.status', value: 'nonsense' }],
      coverage: COVERAGE,
      providerId: 'alpha',
      checkedAt: T0,
    });
    expect(await repos.cache.get(cacheKey('h1', 'blacklist.status'))).toBeUndefined();
  });

  it('is keyed per IMEI hash, so one device cannot answer for another', async () => {
    const { cache: c } = await cache();
    await c.write({
      imeiHash: 'h1',
      fields: [{ field: 'blacklist.status', value: 'blocked' }],
      coverage: COVERAGE,
      providerId: 'alpha',
      checkedAt: T0,
    });
    const other = await c.read({
      imeiHash: 'h2',
      capability: 'blacklist.gsma',
      fields: ['blacklist.status'],
      now: T0,
    });
    expect(other).toEqual([]);
  });

  it('purges expired rows', async () => {
    const { repos, cache: c } = await cache();
    await c.write({
      imeiHash: 'h1',
      fields: [{ field: 'blacklist.status', value: 'clean' }],
      coverage: COVERAGE,
      providerId: 'alpha',
      checkedAt: T0,
    });
    expect(await repos.cache.purgeExpired(new Date(T0.getTime() + 7200_000))).toBe(1);
  });
});
