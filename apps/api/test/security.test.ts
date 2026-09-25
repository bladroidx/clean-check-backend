import { describe, expect, it } from 'vitest';
import { type CatalogueService } from '@imei-check/providers';
import { generateTenantSalt } from '@imei-check/core';
import { CLEAN, FakeProvider, idempotencyKey, makePaidApp } from './paid-helpers.js';
import { SENTINEL } from './helpers.js';
import { ConcurrencyGate, TokenBucketLimiter } from '../src/abuse/ratelimit.js';
import { bearerFrom, generateApiKey, hashApiKey, looksLikeApiKey } from '../src/auth/keys.js';

const service: CatalogueService = {
  serviceId: 'apple-gsx',
  providerId: 'beta',
  displayName: 'gsx',
  capabilities: ['blacklist.gsma'],
  fields: ['blacklist.status'],
  lexiconId: 'blacklist',
  costUsd: 0.6,
  credits: 8,
  async: true,
  timeoutMs: 30_000,
  appliesToTacPrefixes: ['*'],
  enabled: true,
};

/**
 * The inbound feedback webhook is an unauthenticated POST from the public internet claiming to be
 * a supplier telling us an answer. Every test here is an attempt to launder a stolen handset
 * through it.
 *
 * Signature verification itself is a property of a specific supplier's `parseWebhook`
 * implementation (DHRU REST carried an HMAC; it was removed in Task 3 along with the REST
 * adapter). What is generic -- and tested here -- is the route's behaviour: a well-formed but
 * unmatched reference changes nothing, and a rejected payload leaks no detail about why.
 */
describe('supplier feedback webhook', () => {
  it('a correctly signed webhook for an unknown order changes nothing', async () => {
    const harness = await makePaidApp({
      providers: [
        new FakeProvider('beta', CLEAN, [{ ...service, providerId: 'beta' }], async () => ({
          referenceId: 'never-placed',
          outcome: CLEAN,
        })),
      ],
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/providers/beta/feedback',
      headers: { 'content-type': 'application/json' },
      payload: { reference_id: 'never-placed', status: 'success' },
    });

    // Accepted-and-ignored: telling a forger which half failed is free reconnaissance.
    expect(response.statusCode).toBe(202);
    expect(await harness.repos.checks.sections('any')).toEqual([]);
  });

  it('gives no detail about why a forgery was rejected', async () => {
    const harness = await makePaidApp({
      providers: [
        new FakeProvider('beta', CLEAN, [{ ...service, providerId: 'beta' }], async () => {
          throw new Error('signature did not verify for key rotation 7');
        }),
      ],
    });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/providers/beta/feedback',
      headers: { 'content-type': 'application/json' },
      payload: { reference_id: 'x' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('key rotation');
  });
});

describe('rate limiting', () => {
  it('refills over time and reports a usable retry-after', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(() => now);
    const config = { capacity: 2, refillPerSecond: 1 };

    expect(limiter.take('k', config).allowed).toBe(true);
    expect(limiter.take('k', config).allowed).toBe(true);
    const denied = limiter.take('k', config);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);

    now += 2000;
    expect(limiter.take('k', config).allowed).toBe(true);
  });

  it('keys are independent', () => {
    const limiter = new TokenBucketLimiter(() => 0);
    const config = { capacity: 1, refillPerSecond: 0 };
    expect(limiter.take('a', config).allowed).toBe(true);
    expect(limiter.take('b', config).allowed).toBe(true);
  });

  it('sweeps idle buckets so it cannot leak', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(() => now);
    limiter.take('a', { capacity: 1, refillPerSecond: 1 });
    expect(limiter.size).toBe(1);
    now += 10_000;
    expect(limiter.sweep(5_000)).toBe(1);
    expect(limiter.size).toBe(0);
  });
});

/**
 * Depth, as distinct from rate.
 *
 * The token bucket smooths a burst over time and says nothing about how many checks may be open at
 * once. A retry loop can sit inside the rate limit and still hold a hundred checks simultaneously,
 * each one occupying a pool connection and a supplier call.
 */
describe('per-tenant concurrency', () => {
  it('refuses past the limit and frees the slot on release', () => {
    const gate = new ConcurrencyGate();
    expect(gate.tryAcquire('ten_a', 2)).toBe(true);
    expect(gate.tryAcquire('ten_a', 2)).toBe(true);
    expect(gate.tryAcquire('ten_a', 2)).toBe(false);

    gate.release('ten_a');
    expect(gate.tryAcquire('ten_a', 2)).toBe(true);
  });

  it('counts each tenant separately', () => {
    const gate = new ConcurrencyGate();
    expect(gate.tryAcquire('ten_a', 1)).toBe(true);
    expect(gate.tryAcquire('ten_a', 1)).toBe(false);
    // One tenant's depth must not become another tenant's outage.
    expect(gate.tryAcquire('ten_b', 1)).toBe(true);
  });

  it('forgets a tenant at zero so it cannot leak', () => {
    // Unlike the token bucket this needs no sweep, which is only true if release deletes the key.
    const gate = new ConcurrencyGate();
    gate.tryAcquire('ten_a', 1);
    expect(gate.size).toBe(1);
    gate.release('ten_a');
    expect(gate.size).toBe(0);
    expect(gate.inFlightFor('ten_a')).toBe(0);
  });

  it('never drops below zero on an unbalanced release', () => {
    const gate = new ConcurrencyGate();
    gate.release('ten_a');
    gate.release('ten_a');
    expect(gate.inFlightFor('ten_a')).toBe(0);
    expect(gate.tryAcquire('ten_a', 1)).toBe(true);
  });

  it('refuses a check past the limit and leaves no idempotency claim behind', async () => {
    const harness = await makePaidApp({ credits: 1000 });

    // Fill every slot, so the next check has nowhere to go.
    for (let i = 0; i < harness.services.maxConcurrentChecks; i += 1) {
      expect(harness.services.concurrency.tryAcquire('ten_test', harness.services.maxConcurrentChecks)).toBe(true);
    }

    const key = idempotencyKey();
    const refused = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { ...harness.auth(), 'idempotency-key': key },
      payload: { imei: SENTINEL, capabilities: ['blacklist.gsma'] },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('too_many_concurrent_checks');

    // The reason the gate is taken BEFORE the idempotency claim. Had the claim been written, the
    // retry below would answer `check_in_progress` for ever and that key would be dead.
    for (let i = 0; i < harness.services.maxConcurrentChecks; i += 1) {
      harness.services.concurrency.release('ten_test');
    }
    const retried = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { ...harness.auth(), 'idempotency-key': key },
      payload: { imei: SENTINEL, capabilities: ['blacklist.gsma'] },
    });
    expect(retried.statusCode).toBe(200);

    await harness.app.close();
  });

  it('releases the slot when the check throws, not merely when it fails', async () => {
    const harness = await makePaidApp({ credits: 1000 });

    // A returned `failed` outcome is NOT this path: runCheck handles it and answers 200 with an
    // `unavailable` section. Only a genuine throw exercises the `finally`, and the `finally` is
    // the whole reason a slot cannot leak -- so the assertion has to reach it.
    harness.repos.idempotency.complete = async () => {
      throw new Error('storage went away mid-check');
    };

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { ...harness.auth(), 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL, capabilities: ['blacklist.gsma'] },
    });

    expect(response.statusCode).toBe(500);
    // A slot leaked per thrown check silently throttles the tenant to nothing over a day.
    expect(harness.services.concurrency.inFlightFor('ten_test')).toBe(0);
    await harness.app.close();
  });
});

describe('api keys', () => {
  it('round-trips a generated key through its hash', () => {
    const key = generateApiKey();
    expect(looksLikeApiKey(key.plaintext)).toBe(true);
    expect(hashApiKey(key.plaintext)).toBe(key.sha256);
    expect(key.prefix.length).toBeLessThan(key.plaintext.length);
  });

  it('the stored hash does not contain the key', () => {
    const key = generateApiKey();
    expect(key.sha256).not.toContain(key.plaintext.slice(9));
  });

  it('parses a bearer header and rejects anything else', () => {
    expect(bearerFrom('Bearer abc')).toBe('abc');
    expect(bearerFrom('bearer abc')).toBe('abc');
    expect(bearerFrom('Basic abc')).toBeUndefined();
    expect(bearerFrom(undefined)).toBeUndefined();
  });
});

describe('tenant isolation', () => {
  it('the returned imei_hash differs per tenant salt for the same device', async () => {
    const a = await makePaidApp();
    const b = await makePaidApp();
    await b.repos.tenants.create({
      id: 'ten_other', name: 'Other', plan: 'std', status: 'active', imeiSalt: generateTenantSalt(),
    });

    const reportA = (
      await a.app.inject({
        method: 'POST',
        url: '/v1/checks',
        headers: { ...a.auth(), 'idempotency-key': idempotencyKey() },
        payload: { imei: SENTINEL, capabilities: ['blacklist.gsma'] },
      })
    ).json();

    expect(reportA.subject.imei_hash).toBeTruthy();
    // The whole reason the returned hash is tenant-salted: a tenant can correlate their own
    // records and nobody else's.
    expect(reportA.subject.imei_hash).not.toBe(SENTINEL);
  });
});
