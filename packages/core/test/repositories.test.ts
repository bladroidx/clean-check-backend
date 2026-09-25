import { describe, expect, it } from 'vitest';
import { MemoryRepositories } from '../src/db/memory.js';
import { generateTenantSalt } from '../src/db/tenant-salt.js';
import { coverageFor } from '../src/report/coverage.js';
import { identityCoverage } from '../src/report/tac-coverage.js';
import { Capability } from '@imei-check/contract';
import { InMemoryTacDirectory } from '@imei-check/identity';

/**
 * The repository contract, asserted against the in-memory implementation.
 *
 * These are the behaviours the Postgres implementation must also satisfy; keeping them here means
 * the contract is pinned even in the lane that does not start a database.
 */

async function repos() {
  const r = new MemoryRepositories();
  await r.tenants.create({
    id: 't1', name: 'T', plan: 'std', status: 'active', imeiSalt: generateTenantSalt(),
  });
  return r;
}

describe('tenants and keys', () => {
  it('round-trips a tenant and returns undefined for an unknown one', async () => {
    const r = await repos();
    expect((await r.tenants.byId('t1'))?.name).toBe('T');
    expect(await r.tenants.byId('nope')).toBeUndefined();
  });

  /**
   * What the nightly reconciliation iterates.
   *
   * Suspended tenants are included deliberately: a suspended account still holds a balance, and a
   * drift that appeared before the suspension is exactly the one nobody ever finds if the sweep
   * skips it. An empty list here is how ledger drift went undetected entirely.
   */
  it('lists every tenant for reconciliation, suspended ones included', async () => {
    const r = await repos();
    await r.tenants.create({
      id: 't2', name: 'Suspended', plan: 'std', status: 'suspended', imeiSalt: generateTenantSalt(),
    });

    const all = await r.tenants.listAll();
    expect(all.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('finds an API key only by its hash', async () => {
    const r = await repos();
    await r.apiKeys.insert({
      id: 'k1', tenantId: 't1', prefix: 'imc_test_ab', keySha256: 'deadbeef',
      scopes: [], revokedAt: undefined, expiresAt: undefined,
    });
    expect((await r.apiKeys.byHash('deadbeef'))?.id).toBe('k1');
    expect(await r.apiKeys.byHash('imc_test_ab')).toBeUndefined();
  });
});

describe('checks', () => {
  it('stores a check and scopes reads to the owning tenant', async () => {
    const r = await repos();
    await r.checks.insert({
      id: 'chk_1', tenantId: 't1', imeiHash: 'h', subjectHash: 's', imeiMasked: '35•••76',
      tac: '35310411', requestedCapabilities: ['blacklist.gsma'], status: 'pending',
      idempotencyKey: undefined, creditsCharged: 0, verdict: undefined,
      createdAt: new Date(), completedAt: undefined,
    });
    expect(await r.checks.byId('t1', 'chk_1')).toBeDefined();
    // Another tenant must not be able to read it by guessing the id.
    expect(await r.checks.byId('t2', 'chk_1')).toBeUndefined();
  });

  it('upserts a section rather than duplicating it when an async answer lands', async () => {
    const r = await repos();
    const section = {
      capability: 'blacklist.gsma' as const,
      outcome: 'pass' as const,
      checked_at: new Date().toISOString(),
      coverage: { registries: [], caveats: [] },
      evidence: [],
      freshness: { cached: false, age_seconds: 0, ttl_seconds: 0 },
    };
    await r.checks.putSection({ checkId: 'c', capability: 'blacklist.gsma', outcome: 'inconclusive', section });
    await r.checks.putSection({ checkId: 'c', capability: 'blacklist.gsma', outcome: 'pass', section });

    const stored = await r.checks.sections('c');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.outcome).toBe('pass');
  });
});

describe('provider calls', () => {
  it('records the in-flight row then finishes it, and sums cost', async () => {
    const r = await repos();
    const startedAt = new Date();
    await r.providerCalls.start({
      id: 'pc1', checkId: 'c', tenantId: 't1', providerId: 'alpha', serviceId: '12',
      capability: 'blacklist.gsma', status: 'in_flight', providerCostUsd: 0.12,
      creditsCharged: 0, billable: true, latencyMs: undefined, errorCode: undefined,
      startedAt, finishedAt: undefined,
    });
    await r.providerCalls.finish('pc1', { status: 'answered', latencyMs: 120 });

    expect(await r.providerCalls.costSince('t1', new Date(startedAt.getTime() - 1000))).toBeCloseTo(0.12);
    expect(await r.providerCalls.costSince('t1', new Date(startedAt.getTime() + 10_000))).toBe(0);
  });
});

describe('orders', () => {
  it('finds by reference, lists due polls and closes out', async () => {
    const r = await repos();
    const now = new Date();
    await r.orders.insert({
      id: 'o1', checkId: 'c1', tenantId: 't1', providerId: 'beta', serviceId: 'gsx',
      capability: 'blacklist.gsma', referenceId: 'ref1', orderReference: 'sup1', imeiHash: 'h1',
      status: 'pending', attempts: 0, nextPollAt: now,
      expiresAt: new Date(now.getTime() + 3600_000), createdAt: now, settledAt: undefined,
    });

    expect((await r.orders.byReference('ref1'))?.id).toBe('o1');
    expect(await r.orders.duePolls(now, 10)).toHaveLength(1);
    expect(await r.orders.openForCheck('c1')).toHaveLength(1);

    await r.orders.update('o1', { status: 'answered' });
    expect(await r.orders.openForCheck('c1')).toHaveLength(0);
    expect(await r.orders.duePolls(now, 10)).toHaveLength(0);
  });
});

describe('idempotency records', () => {
  it('claims once, then reports the existing row', async () => {
    const r = await repos();
    const record = { tenantId: 't1', key: 'k', requestDigest: 'd' };

    expect(await r.idempotency.claim(record)).toEqual({ claimed: true });

    const second = await r.idempotency.claim(record);
    expect(second.claimed).toBe(false);
    if (second.claimed === false) expect(second.existing.requestDigest).toBe('d');
  });

  it('stores the response so a retry can be replayed rather than re-run', async () => {
    const r = await repos();
    await r.idempotency.claim({ tenantId: 't1', key: 'k', requestDigest: 'd' });
    await r.idempotency.complete('t1', 'k', {
      checkId: 'chk_1', statusCode: 200, responseBody: { ok: true },
    });

    const again = await r.idempotency.claim({ tenantId: 't1', key: 'k', requestDigest: 'd' });
    if (again.claimed === false) {
      expect(again.existing.responseBody).toEqual({ ok: true });
      expect(again.existing.completedAt).toBeDefined();
    }
  });
});

describe('coverage metadata', () => {
  const directory = InMemoryTacDirectory.from(
    [['35310411', { manufacturer: 'Apple', model: 'iPhone 13', source: 'osmocom' }]],
    'v1',
    'TAC data (c) Osmocom contributors, CC BY-SA 3.0',
  );

  it('gives every capability a non-empty coverage with caveats', () => {
    for (const capability of Capability.options) {
      const coverage = coverageFor(capability, directory);
      expect(coverage.registries.length, capability).toBeGreaterThan(0);
      // The difference between a true statement and a misleading one.
      expect(coverage.caveats.length, capability).toBeGreaterThan(0);
    }
  });

  it('never names the upstream provider to the caller', () => {
    for (const capability of Capability.options) {
      const text = JSON.stringify(coverageFor(capability, directory)).toLowerCase();
      // Our supply chain, not theirs.
      expect(text).not.toContain('dhru');
      expect(text).not.toContain('alpha');
      expect(text).not.toContain('beta');
    }
  });

  it('carries the CC-BY-SA attribution on the offline identity section', () => {
    // Attribution is how BY is satisfied without ever redistributing the compilation (ADR-0005).
    expect(identityCoverage(directory).attribution).toContain('CC BY-SA');
    expect(identityCoverage(directory).source_version).toBe('v1');
  });

  it('marks the GSMA answer as covering reporting networks, not the world', () => {
    const coverage = coverageFor('blacklist.gsma', directory);
    expect(coverage.region_model).toBe('reporting_networks');
    expect(coverage.partial_in?.length).toBeGreaterThan(0);
  });
});
