import { describe, expect, it } from 'vitest';
import { MemoryRepositories, Metrics, generateTenantSalt, type Repositories } from '@imei-check/core';
import { InMemoryTacDirectory } from '@imei-check/identity';
import type { CatalogueService, Provider, ProviderOutcome } from '@imei-check/providers';
import { backoffFor, pollOrders } from '../src/jobs/poll-orders.js';
import { ChecksumMismatch, ingestTacCsv, observationFrom, parseTacCsv } from '../src/jobs/tac-ingest.js';

const directory = InMemoryTacDirectory.from(
  [['35310411', { manufacturer: 'Apple', model: 'iPhone 13', source: 'bundled' }]],
  'test-1',
);

const service: CatalogueService = {
  serviceId: 'gsx',
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

class PollableProvider implements Provider {
  readonly id = 'beta';
  polls = 0;
  constructor(private readonly outcome: ProviderOutcome) {}
  catalogue(): readonly CatalogueService[] {
    return [service];
  }
  supports(): CatalogueService | undefined {
    return service;
  }
  async execute(): Promise<ProviderOutcome> {
    return this.outcome;
  }
  async poll(_orderReference: string, _service: CatalogueService): Promise<ProviderOutcome> {
    this.polls += 1;
    return this.outcome;
  }
}

async function seeded(overrides: Partial<Parameters<Repositories['orders']['insert']>[0]> = {}) {
  const repos = new MemoryRepositories();
  await repos.tenants.create({
    id: 't1', name: 'T', plan: 'std', status: 'active', imeiSalt: generateTenantSalt(),
  });
  await repos.checks.insert({
    id: 'chk_1',
    tenantId: 't1',
    imeiHash: 'h',
    subjectHash: 's',
    imeiMasked: '35•••••••••••76',
    tac: '35310411',
    requestedCapabilities: ['blacklist.gsma'],
    status: 'partial',
    idempotencyKey: undefined,
    creditsCharged: 0,
    verdict: undefined,
    createdAt: new Date('2026-09-13T00:00:00Z'),
    completedAt: undefined,
  });
  await repos.orders.insert({
    id: 'ord_1',
    checkId: 'chk_1',
    tenantId: 't1',
    providerId: 'beta',
    serviceId: 'gsx',
    capability: 'blacklist.gsma',
    referenceId: 'ref_1',
    orderReference: 'supplier_1',
    status: 'pending',
    attempts: 0,
    nextPollAt: new Date('2026-09-13T00:00:00Z'),
    expiresAt: new Date('2026-09-14T00:00:00Z'),
    createdAt: new Date('2026-09-13T00:00:00Z'),
    settledAt: undefined,
    ...overrides,
  });
  return repos;
}

describe('polling standard orders', () => {
  const now = () => new Date('2026-09-13T01:00:00Z');

  it('settles an answered order into a section and completes the check', async () => {
    const repos = await seeded();
    const provider = new PollableProvider({
      kind: 'answered',
      fields: [{ field: 'blacklist.status', value: 'clean' }],
      misses: [],
    });

    const summary = await pollOrders({
      repos, providers: [provider], tacDirectory: directory, metrics: new Metrics(false), now,
    });

    expect(summary.answered).toBe(1);
    const sections = await repos.checks.sections('chk_1');
    expect(sections[0]?.outcome).toBe('pass');
    expect((await repos.checks.byId('t1', 'chk_1'))?.status).toBe('complete');
  });

  it('backs off rather than hammering a still-pending order', async () => {
    const repos = await seeded();
    const provider = new PollableProvider({ kind: 'pending', orderReference: 'supplier_1' });

    const summary = await pollOrders({
      repos, providers: [provider], tacDirectory: directory, metrics: new Metrics(false), now,
    });

    expect(summary.stillPending).toBe(1);
    const order = await repos.orders.byReference('ref_1');
    expect(order?.attempts).toBe(1);
    expect(order?.nextPollAt?.getTime()).toBeGreaterThan(now().getTime());
  });

  it('does not settle a section on a transport failure', async () => {
    const repos = await seeded();
    const provider = new PollableProvider({ kind: 'failed', reason: 'timeout' });

    await pollOrders({
      repos, providers: [provider], tacDirectory: directory, metrics: new Metrics(false), now,
    });

    // The order is still open at the supplier and still paid for. Settling it as unavailable here
    // would throw away an answer we may yet receive.
    expect(await repos.checks.sections('chk_1')).toEqual([]);
    expect((await repos.orders.byReference('ref_1'))?.status).toBe('pending');
  });

  it('abandons an expired order and marks the section unavailable', async () => {
    const repos = await seeded({ expiresAt: new Date('2026-09-13T00:30:00Z') });
    const provider = new PollableProvider({ kind: 'pending', orderReference: 'supplier_1' });

    const summary = await pollOrders({
      repos, providers: [provider], tacDirectory: directory, metrics: new Metrics(false), now,
    });

    expect(summary.abandoned).toBe(1);
    expect(provider.polls).toBe(0);
    const sections = await repos.checks.sections('chk_1');
    expect(sections[0]?.outcome).toBe('unavailable');
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffFor(1)).toBe(5 * 60 * 1000);
    expect(backoffFor(2)).toBe(10 * 60 * 1000);
    expect(backoffFor(20)).toBe(60 * 60 * 1000);
  });
});

describe('TAC ingest', () => {
  it('parses a CSV, including quoted names with commas', () => {
    const { rows } = parseTacCsv('35310411,Apple,"iPhone 13, 128GB",iPhone\n35847191,Samsung,SM-G991B');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.model).toBe('iPhone 13, 128GB');
  });

  /**
   * A seven-digit "TAC" is a corrupt row. Left-padding it would file a real device's identity
   * under a neighbour's code -- permanently, because `tac -> model` is cached with no expiry.
   */
  it('skips a malformed TAC rather than coercing it', () => {
    const { rows, skipped } = parseTacCsv('3531041,Apple,iPhone\n35310411,Apple,iPhone 13');
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('aborts on a checksum mismatch rather than replacing a good directory', async () => {
    await expect(
      ingestTacCsv({
        body: '35310411,Apple,iPhone 13',
        expectedChecksum: 'not-the-checksum',
        source: 'osmocom',
        sourceVersion: 'v1',
        writer: { upsert: async () => {} },
      }),
    ).rejects.toThrow(ChecksumMismatch);
  });

  it('imports when the checksum matches', async () => {
    const written: unknown[] = [];
    const result = await ingestTacCsv({
      body: '35310411,Apple,iPhone 13',
      source: 'osmocom',
      sourceVersion: 'v1',
      writer: { upsert: async (row) => void written.push(row) },
    });
    expect(result.parsed).toBe(1);
    expect(written).toHaveLength(1);
  });

  it('harvests an observation that outranks every imported source', () => {
    const observed = observationFrom('35310411', 'Apple', 'iPhone 13');
    expect(observed?.source).toBe('observed');
    expect(observed?.sourcePriority).toBe(100);
  });

  it('refuses to harvest an incomplete observation', () => {
    expect(observationFrom('35310411', undefined, 'iPhone')).toBeUndefined();
    expect(observationFrom('bad', 'Apple', 'iPhone')).toBeUndefined();
  });
});
