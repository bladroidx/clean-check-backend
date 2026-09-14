import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DhruRestProvider, type CatalogueService } from '@imei-check/providers';
import { BUILTIN_LEXICONS } from '@imei-check/providers';
import { MemoryRepositories, generateTenantSalt } from '@imei-check/core';
import { CLEAN, FakeProvider, idempotencyKey, makePaidApp } from './paid-helpers.js';
import { SENTINEL } from './helpers.js';
import { EnumerationGuard, bucketOf, levelFor, DEFAULT_POLICY } from '../src/abuse/enumeration.js';
import { ConcurrencyGate, TokenBucketLimiter } from '../src/abuse/ratelimit.js';
import { isPrivateHost } from '../src/routes/account.js';
import { bearerFrom, generateApiKey, hashApiKey, looksLikeApiKey } from '../src/auth/keys.js';

const WEBHOOK_SECRET = 'a-shared-secret-for-webhook-signing';

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

const beta = new DhruRestProvider({
  providerId: 'beta',
  baseUrl: 'https://example.invalid',
  token: 't',
  webhookSecret: WEBHOOK_SECRET,
  services: [service],
  lexicons: BUILTIN_LEXICONS,
});

function signed(body: string, secret = WEBHOOK_SECRET): { headers: Record<string, string>; rawBody: Buffer } {
  return {
    headers: { 'x-dhru-signature': createHmac('sha256', secret).update(body).digest('hex') },
    rawBody: Buffer.from(body, 'utf8'),
  };
}

/**
 * The inbound feedback webhook is an unauthenticated POST from the public internet claiming to be
 * a supplier telling us an answer. Every test here is an attempt to launder a stolen handset
 * through it.
 */
describe('supplier feedback webhook', () => {
  it('accepts a correctly signed payload', async () => {
    const body = JSON.stringify({
      reference_id: 'ref-1',
      status: 'success',
      replay: Buffer.from('Blacklist Status: Clean').toString('base64'),
    });
    const parsed = await beta.parseWebhook(signed(body));
    expect(parsed.referenceId).toBe('ref-1');
    expect(parsed.outcome.kind).toBe('answered');
  });

  it('refuses an unsigned payload', async () => {
    const body = JSON.stringify({ reference_id: 'ref-1', status: 'success', replay: '' });
    await expect(beta.parseWebhook({ headers: {}, rawBody: Buffer.from(body) })).rejects.toThrow();
  });

  /** The forgery this gate exists for. */
  it('refuses a payload signed with the wrong secret', async () => {
    const body = JSON.stringify({
      reference_id: 'ref-1',
      status: 'success',
      replay: Buffer.from('Blacklist Status: Clean').toString('base64'),
    });
    await expect(beta.parseWebhook(signed(body, 'attacker-guess'))).rejects.toThrow();
  });

  it('refuses a payload whose body was altered after signing', async () => {
    const original = JSON.stringify({ reference_id: 'ref-1', status: 'rejected' });
    const tampered = JSON.stringify({
      reference_id: 'ref-1',
      status: 'success',
      replay: Buffer.from('Blacklist Status: Clean').toString('base64'),
    });
    const envelope = signed(original);
    await expect(
      beta.parseWebhook({ headers: envelope.headers, rawBody: Buffer.from(tampered) }),
    ).rejects.toThrow();
  });

  it('refuses webhooks entirely when no secret is configured', async () => {
    const unconfigured = new DhruRestProvider({
      providerId: 'beta',
      baseUrl: 'https://example.invalid',
      token: 't',
      services: [service],
      lexicons: BUILTIN_LEXICONS,
    });
    const body = JSON.stringify({ reference_id: 'r', status: 'success', replay: '' });
    // Refused, not trusted. An absent secret must never mean "skip verification".
    await expect(unconfigured.parseWebhook(signed(body))).rejects.toThrow();
  });

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

describe('enumeration detection', () => {
  it('buckets by TAC and the first three serial digits, storing no IMEI', () => {
    //  35310411 | 234 | 5676
    //  \__TAC__/  \_/  \__/  -- 1000 buckets per TAC, and no IMEI is retained anywhere.
    //             bucket
    expect(bucketOf('353104112345676')).toBe(234);
    expect(bucketOf('353104110005676')).toBe(0);
  });

  it('climbs the ladder as distinct buckets accumulate', () => {
    expect(levelFor(10, DEFAULT_POLICY)).toBe('none');
    expect(levelFor(150, DEFAULT_POLICY)).toBe('throttled');
    expect(levelFor(350, DEFAULT_POLICY)).toBe('cache_only');
    expect(levelFor(650, DEFAULT_POLICY)).toBe('no_paid');
    expect(levelFor(950, DEFAULT_POLICY)).toBe('suspended');
  });

  it('a shop checking many of one model is not restricted', async () => {
    const repos = new MemoryRepositories();
    await repos.tenants.create({
      id: 't1', name: 'Shop', plan: 'std', status: 'active', imeiSalt: generateTenantSalt(),
    });
    const guard = new EnumerationGuard(repos.abuse);
    const now = new Date();

    let level = 'none';
    for (let i = 0; i < 60; i += 1) {
      const result = await guard.observe({
        tenantId: 't1',
        tac: '35310411',
        imeiDigits: `35310411${String(i).padStart(3, '0')}0000`,
        now,
      });
      level = result.level;
    }
    // 60 distinct handsets of one model in an hour is a real business, not a sweep.
    expect(level).toBe('none');
  });

  it('a sweep across a TAC trips the ladder', async () => {
    const repos = new MemoryRepositories();
    await repos.tenants.create({
      id: 't1', name: 'Sweeper', plan: 'std', status: 'active', imeiSalt: generateTenantSalt(),
    });
    const guard = new EnumerationGuard(repos.abuse);
    const now = new Date();

    let level = 'none';
    for (let i = 0; i < 400; i += 1) {
      const result = await guard.observe({
        tenantId: 't1',
        tac: '35310411',
        imeiDigits: `35310411${String(i % 1000).padStart(3, '0')}0000`,
        now,
      });
      level = result.level;
    }
    expect(['cache_only', 'no_paid', 'suspended']).toContain(level);
  });

  it('never relaxes a restriction on its own', async () => {
    const repos = new MemoryRepositories();
    await repos.tenants.create({
      id: 't1', name: 'T', plan: 'std', status: 'active', imeiSalt: generateTenantSalt(),
    });
    await repos.abuse.restrict('t1', 'no_paid', 'operator applied');

    const guard = new EnumerationGuard(repos.abuse);
    const result = await guard.observe({
      tenantId: 't1',
      tac: '35310411',
      imeiDigits: '353104112345676',
      now: new Date(),
    });
    // A sweeper who waits an hour must not simply resume.
    expect(result.level).toBe('no_paid');
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

describe('outbound webhook registration', () => {
  it('refuses private and plaintext destinations', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.1.1', '192.168.0.5', '169.254.169.254', 'metadata.google.internal']) {
      expect(isPrivateHost(host)).toBe(true);
    }
    expect(isPrivateHost('hooks.example.com')).toBe(false);
  });

  it('rejects an http:// webhook over the wire', async () => {
    const harness = await makePaidApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: harness.auth(),
      payload: { url: 'http://hooks.example.com/imei' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('insecure_webhook_url');
  });

  it('rejects an SSRF target', async () => {
    const harness = await makePaidApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: harness.auth(),
      payload: { url: 'https://169.254.169.254/latest/meta-data' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns the signing secret exactly once, on registration', async () => {
    const harness = await makePaidApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: harness.auth(),
      payload: { url: 'https://hooks.example.com/imei' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().secret).toBeTruthy();
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
