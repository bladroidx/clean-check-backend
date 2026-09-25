import { describe, expect, it } from 'vitest';
import type { CatalogueService, Provider, ProviderOutcome } from '@imei-check/providers';
import type { TacDirectory } from '@imei-check/identity';
import { MemoryRepositories } from '../src/db/memory.js';
import { generateTenantSalt } from '../src/db/tenant-salt.js';
import type { OrderRow, Repositories } from '../src/db/types.js';
import { Metrics } from '../src/metrics.js';
import { backoffFor, pollDueOrders, pollOrders } from '../src/orders/settle.js';
import { coverageFor } from '../src/report/coverage.js';
import { assembleSection } from '../src/report/assemble.js';

const s486: CatalogueService = {
  serviceId: '486',
  providerId: 'imei24',
  displayName: 'imei24 blacklist',
  capabilities: ['blacklist.gsma'],
  fields: ['blacklist.status'],
  lexiconId: 'blacklist',
  costUsd: 0.1,
  credits: 8,
  async: true,
  timeoutMs: 30_000,
  appliesToTacPrefixes: ['*'],
  enabled: true,
};

const s690: CatalogueService = { ...s486, serviceId: '690' };

const emptyTac: TacDirectory = { lookup: () => undefined, version: 't', size: 0, attribution: undefined };

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'ord_1',
    checkId: 'chk_1',
    tenantId: 't1',
    providerId: 'imei24',
    serviceId: '486',
    capability: 'blacklist.gsma',
    referenceId: 'ref_1',
    orderReference: 'supplier_1',
    imeiHash: 'hash_1',
    status: 'pending',
    attempts: 0,
    nextPollAt: new Date('2026-09-13T00:00:00Z'),
    // Far in the future so the two tests that use the real clock (no `now` override) never treat
    // this as expired, whatever day the suite happens to run on.
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    createdAt: new Date('2026-09-13T00:00:00Z'),
    settledAt: undefined,
    ...overrides,
  };
}

async function seed(repos: Repositories, row: OrderRow): Promise<void> {
  await repos.tenants.create({
    id: row.tenantId, name: 'T', plan: 'std', status: 'active', imeiSalt: generateTenantSalt(),
  });
  await repos.checks.insert({
    id: row.checkId,
    tenantId: row.tenantId,
    imeiHash: row.imeiHash,
    subjectHash: 's',
    imeiMasked: '35•••••••••••76',
    tac: '35310411',
    requestedCapabilities: ['blacklist.gsma'],
    status: 'partial',
    idempotencyKey: undefined,
    creditsCharged: 0,
    verdict: undefined,
    createdAt: row.createdAt,
    completedAt: undefined,
    tier: 'deep',
    imeiEncrypted: undefined,
    imeiKeyVersion: undefined,
  });
  await repos.orders.insert(row);
}

describe('pollDueOrders / pollOrders (shared order settlement)', () => {
  const now = () => new Date('2026-09-13T01:00:00Z');

  it('polls with the service recorded on the order', async () => {
    const seen: string[] = [];
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486, s690],
      supports: () => undefined,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async (_ref: string, svc: CatalogueService) => {
        seen.push(svc.serviceId);
        return { kind: 'pending', orderReference: 'o' } as const;
      },
    };
    const repos = new MemoryRepositories();
    await seed(repos, order({ serviceId: '690', nextPollAt: new Date(0) }));

    await pollDueOrders({ repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false) });

    expect(seen).toEqual(['690']);
  });

  it('abandons an order whose service is no longer in the catalogue', async () => {
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486], // '690' is gone
      supports: () => undefined,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () => ({ kind: 'pending', orderReference: 'o' }) as const,
    };
    const repos = new MemoryRepositories();
    await seed(repos, order({ serviceId: '690', nextPollAt: new Date(0) }));

    const summary = await pollDueOrders({
      repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false),
    });

    expect(summary.abandoned).toBe(1);
    const sections = await repos.checks.sections('chk_1');
    expect(sections[0]?.outcome).toBe('unavailable');
  });

  it('settles an answered order into a section, caches the fields and completes the check with a derived verdict', async () => {
    const repos = new MemoryRepositories();
    await seed(repos, order());
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486],
      supports: () => s486,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () =>
        ({ kind: 'answered', fields: [{ field: 'blacklist.status', value: 'clean' }], misses: [] }) as const,
    };

    const summary = await pollOrders(
      { repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now },
      [order()],
    );

    expect(summary.answered).toBe(1);
    const sections = await repos.checks.sections('chk_1');
    expect(sections[0]?.outcome).toBe('pass');
    const check = await repos.checks.byId('t1', 'chk_1');
    expect(check?.status).toBe('complete');
    expect(check?.verdict).toBe('green');
    // The async path now writes the field cache, same as the synchronous path.
    const cached = await repos.cache.get('hash_1:blacklist.status');
    expect(cached?.value).toBe('clean');
  });

  it('settles a pre-migration order with no stored imeiHash normally, but skips the cache write', async () => {
    const repos = new MemoryRepositories();
    const noHash = order({ imeiHash: '' });
    await seed(repos, noHash);
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486],
      supports: () => s486,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () =>
        ({ kind: 'answered', fields: [{ field: 'blacklist.status', value: 'clean' }], misses: [] }) as const,
    };

    const summary = await pollOrders(
      { repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now },
      [noHash],
    );

    expect(summary.answered).toBe(1);
    const sections = await repos.checks.sections('chk_1');
    expect(sections[0]?.outcome).toBe('pass');
    // An empty key would make every hash-less order share one cache row, so nothing is written.
    expect(await repos.cache.get(':blacklist.status')).toBeUndefined();
  });

  it('does not settle a section on a transport failure, and retries with backoff', async () => {
    const repos = new MemoryRepositories();
    await seed(repos, order());
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486],
      supports: () => s486,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
    };

    await pollOrders(
      { repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now },
      [order()],
    );

    expect(await repos.checks.sections('chk_1')).toEqual([]);
    expect((await repos.orders.byReference('ref_1'))?.status).toBe('pending');
  });

  it('abandons an expired order and marks the section unavailable, without polling', async () => {
    const repos = new MemoryRepositories();
    const expired = order({ expiresAt: new Date('2026-09-13T00:30:00Z') });
    await seed(repos, expired);
    let polled = false;
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486],
      supports: () => s486,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () => {
        polled = true;
        return { kind: 'pending', orderReference: 'o' } as const;
      },
    };

    const summary = await pollOrders(
      { repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now },
      [expired],
    );

    expect(summary.abandoned).toBe(1);
    expect(polled).toBe(false);
    const sections = await repos.checks.sections('chk_1');
    expect(sections[0]?.outcome).toBe('unavailable');
    // Spec section 5 / R14: the honest reason is that we gave up WAITING, not a supplier timeout.
    expect(sections[0]?.section).toMatchObject({ outcome: 'unavailable', reason: 'awaiting_provider_timed_out' });
  });

  it('advanceBackoff: false (the API wait window) leaves attempts and nextPollAt untouched', async () => {
    const repos = new MemoryRepositories();
    const row = order();
    await seed(repos, row);
    for (const outcome of [{ kind: 'pending', orderReference: 'o' }, { kind: 'failed', reason: 'timeout' }] as const) {
      const provider: Provider = {
        id: 'imei24',
        catalogue: () => [s486],
        supports: () => s486,
        execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
        poll: async () => outcome,
      };
      const summary = await pollOrders(
        { repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now },
        [row],
        { advanceBackoff: false },
      );
      expect(summary.stillPending).toBe(1);
      const after = await repos.orders.byReference('ref_1');
      expect(after?.attempts).toBe(0);
      expect(after?.nextPollAt).toEqual(row.nextPollAt);
    }
    // The worker's default still advances it.
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486],
      supports: () => s486,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () => ({ kind: 'pending', orderReference: 'o' }) as const,
    };
    await pollOrders({ repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now }, [row]);
    expect((await repos.orders.byReference('ref_1'))?.attempts).toBe(1);
  });

  it('stops before polling once the signal has aborted', async () => {
    const repos = new MemoryRepositories();
    await seed(repos, order());
    let polled = 0;
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486],
      supports: () => s486,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () => {
        polled += 1;
        return { kind: 'pending', orderReference: 'o' } as const;
      },
    };
    const summary = await pollOrders(
      { repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now },
      [order()],
      { signal: AbortSignal.abort() },
    );
    expect(polled).toBe(0);
    expect(summary.stillPending).toBe(1);
  });

  it('polls a multi-capability order ONCE and caches each field under its own capability coverage', async () => {
    const s690multi: CatalogueService = {
      ...s486,
      serviceId: '690',
      capabilities: ['blacklist.gsma', 'lock.carrier'],
      fields: ['blacklist.status', 'lock.carrier.status'],
    };
    const repos = new MemoryRepositories();
    const blacklistRow = order({ serviceId: '690' });
    const carrierRow = order({ id: 'ord_2', referenceId: 'ref_2', serviceId: '690', capability: 'lock.carrier' });
    await seed(repos, blacklistRow);
    await repos.orders.insert(carrierRow);
    let polls = 0;
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s690multi],
      supports: () => s690multi,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () => {
        polls += 1;
        return {
          kind: 'answered',
          fields: [
            { field: 'blacklist.status', value: 'clean' },
            { field: 'lock.carrier.status', value: 'unlocked' },
          ],
          misses: [],
        } as const;
      },
    };

    // Carrier row first: with one write per row under the row's capability, the LAST row's
    // coverage would win for every field.
    const summary = await pollOrders(
      { repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now },
      [carrierRow, blacklistRow],
    );

    expect(polls).toBe(1);
    expect(summary.answered).toBe(2);
    expect((await repos.cache.get('hash_1:blacklist.status'))?.coverage).toEqual(coverageFor('blacklist.gsma', emptyTac));
    expect((await repos.cache.get('hash_1:lock.carrier.status'))?.coverage).toEqual(coverageFor('lock.carrier', emptyTac));
    const sections = await repos.checks.sections('chk_1');
    expect(sections.map((x) => x.capability).sort()).toEqual(['blacklist.gsma', 'lock.carrier']);
    expect((await repos.checks.byId('t1', 'chk_1'))?.status).toBe('complete');
  });

  /**
   * Final review F5: the verdict was only recomputed once no order was left open, so a `fail`
   * landing while another order was still pending sat under the provisional `amber`.
   */
  it('recomputes the verdict on EVERY settle, not only once the check is complete', async () => {
    const repos = new MemoryRepositories();
    const blacklistRow = order();
    const carrierRow = order({ id: 'ord_2', referenceId: 'ref_2', orderReference: 'supplier_2', capability: 'lock.carrier' });
    await seed(repos, blacklistRow);
    await repos.orders.insert(carrierRow);
    await repos.checks.update('chk_1', { verdict: 'amber' });
    const provider: Provider = {
      id: 'imei24',
      catalogue: () => [s486],
      supports: () => s486,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () =>
        ({ kind: 'answered', fields: [{ field: 'blacklist.status', value: 'blocked' }], misses: [] }) as const,
    };

    await pollOrders(
      { repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now },
      [blacklistRow],
    );

    const check = await repos.checks.byId('t1', 'chk_1');
    expect(check?.status).toBe('partial');
    expect(check?.verdict).toBe('red');
  });

  /**
   * Final review F4: `warranty.status` is derived from `warranty.purchase_date`. On the deep route
   * the purchase date is always an async order, so the derived section has to wait for it -- and
   * be re-derived when it lands, rather than staying whatever it was at placement.
   */
  describe('warranty.status follows its purchase date', () => {
    const sWarranty: CatalogueService = {
      ...s486,
      serviceId: '428',
      capabilities: ['warranty.purchase_date'],
      fields: ['warranty.purchase_date'],
    };
    const purchaseRow = () => order({ serviceId: '428', capability: 'warranty.purchase_date' });

    async function seedAwaiting(repos: Repositories, row: OrderRow): Promise<void> {
      await seed(repos, row);
      const awaiting = assembleSection({
        capability: 'warranty.status',
        outcome: { kind: 'pending', orderReference: 'supplier_1' },
        coverage: coverageFor('warranty.status', emptyTac),
        checkedAt: new Date('2026-09-13T00:00:00Z'),
      });
      await repos.checks.putSection({ checkId: 'chk_1', capability: 'warranty.status', outcome: awaiting.outcome, section: awaiting });
    }

    const pollWith = (outcome: ProviderOutcome): Provider => ({
      id: 'imei24',
      catalogue: () => [sWarranty],
      supports: () => sWarranty,
      execute: async () => ({ kind: 'failed', reason: 'timeout' }) as const,
      poll: async () => outcome,
    });

    const warranty = async (repos: Repositories) =>
      (await repos.checks.sections('chk_1')).find((x) => x.capability === 'warranty.status')?.section;

    it('is re-derived from the purchase date when it settles', async () => {
      const repos = new MemoryRepositories();
      const row = purchaseRow();
      await seedAwaiting(repos, row);
      const provider = pollWith({
        kind: 'answered',
        fields: [{ field: 'warranty.purchase_date', value: '2026-03-01T00:00:00.000Z' }],
        misses: [],
      });

      await pollOrders({ repos, providers: [provider], tacDirectory: emptyTac, metrics: new Metrics(false), now }, [row]);

      expect(await warranty(repos)).toMatchObject({
        outcome: 'pass',
        evidence: expect.arrayContaining([expect.objectContaining({ label: 'Purchase date' })]),
      });
      const check = await repos.checks.byId('t1', 'chk_1');
      expect(check?.status).toBe('complete');
      expect(check?.verdict).toBe('green');
    });

    it('is unavailable when the answer carries no purchase date', async () => {
      const repos = new MemoryRepositories();
      const row = purchaseRow();
      await seedAwaiting(repos, row);
      await pollOrders(
        { repos, providers: [pollWith({ kind: 'answered', fields: [], misses: [] })], tacDirectory: emptyTac, metrics: new Metrics(false), now },
        [row],
      );
      expect(await warranty(repos)).toMatchObject({ outcome: 'unavailable', reason: 'capability_not_supported_for_device' });
    });

    it('times out with its purchase date', async () => {
      const repos = new MemoryRepositories();
      const row = { ...purchaseRow(), expiresAt: new Date('2026-09-13T00:30:00Z') };
      await seedAwaiting(repos, row);
      await pollOrders(
        { repos, providers: [pollWith({ kind: 'pending', orderReference: 'x' })], tacDirectory: emptyTac, metrics: new Metrics(false), now },
        [row],
      );
      expect(await warranty(repos)).toMatchObject({ outcome: 'unavailable', reason: 'awaiting_provider_timed_out' });
    });
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffFor(1)).toBe(5 * 60 * 1000);
    expect(backoffFor(2)).toBe(10 * 60 * 1000);
    expect(backoffFor(20)).toBe(60 * 60 * 1000);
  });
});
