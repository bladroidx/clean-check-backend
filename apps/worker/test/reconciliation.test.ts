import { describe, expect, it } from 'vitest';
import { GuardedProvider, MemoryRepositories, Metrics } from '@imei-check/core';
import type { CatalogueService, Provider, ProviderOutcome } from '@imei-check/providers';
import { reconcileBalances, type Log } from '../src/jobs/reconcile-balance.js';
import { detectCatalogueDrift } from '../src/jobs/catalogue-drift.js';

const service = (serviceId: string, costUsd: number, enabled = true): CatalogueService => ({
  serviceId,
  providerId: 'imei24',
  displayName: serviceId,
  capabilities: ['blacklist.gsma'],
  fields: ['blacklist.status'],
  lexiconId: 'imei24-blacklist',
  costUsd,
  credits: 0,
  async: true,
  timeoutMs: 8_000,
  appliesToTacPrefixes: ['*'],
  enabled,
});

class FakeSupplier implements Provider {
  readonly id = 'imei24';
  balance: number | undefined = 100;
  reachable = true;
  prices: ReadonlyMap<string, number> | undefined = new Map([['486', 0.1]]);
  calls = 0;
  constructor(private readonly services: readonly CatalogueService[] = [service('486', 0.1)]) {}
  catalogue() {
    return this.services;
  }
  supports() {
    return this.services[0];
  }
  async execute(): Promise<ProviderOutcome> {
    this.calls += 1;
    return { kind: 'pending', orderReference: 'o1' };
  }
  async health() {
    return this.reachable
      ? { reachable: true, ...(this.balance !== undefined ? { balanceUsd: this.balance } : {}) }
      : { reachable: false };
  }
  async servicePrices() {
    return this.prices;
  }
}

function recorder(): { log: Log; lines: Array<{ level: string; message: string; event: Record<string, unknown> }> } {
  const lines: Array<{ level: string; message: string; event: Record<string, unknown> }> = [];
  return { lines, log: (level, event, message) => void lines.push({ level, event, message }) };
}

async function spend(repos: MemoryRepositories, usd: number, at: Date, id = `pc_${Math.random()}`) {
  await repos.providerCalls.start({
    id,
    checkId: undefined,
    tenantId: 't1',
    providerId: 'imei24',
    serviceId: '486',
    capability: 'blacklist.gsma',
    status: 'answered',
    providerCostUsd: usd,
    creditsCharged: 0,
    billable: true,
    latencyMs: 1,
    errorCode: undefined,
    startedAt: at,
    finishedAt: at,
  });
}

const t0 = new Date('2026-09-27T00:00:00Z');
const t1 = new Date('2026-09-27T01:00:00Z');

describe('balance reconcile', () => {
  it('records a first snapshot and exports the balance', async () => {
    const repos = new MemoryRepositories();
    const metrics = new Metrics(false);
    const { log } = recorder();
    const out = await reconcileBalances({ providers: [new FakeSupplier()], repos, metrics, log, now: () => t0 });
    expect(out.results[0]).toMatchObject({ status: 'first_snapshot', balanceUsd: 100 });
    expect(out.complete).toBe(true);
    expect(await metrics.render()).toContain('imei_provider_balance_usd{provider_id="imei24"} 100');
  });

  it('is quiet when the balance fell by what our books recorded', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    const metrics = new Metrics(false);
    const { log, lines } = recorder();
    await reconcileBalances({ providers: [supplier], repos, metrics, log, now: () => t0 });
    for (let i = 0; i < 20; i += 1) await spend(repos, 0.1, new Date(t0.getTime() + 60_000 * (i + 1)));
    supplier.balance = 98;

    const out = await reconcileBalances({ providers: [supplier], repos, metrics, log, now: () => t1 });
    expect(out.results[0]).toMatchObject({ status: 'ok', observedDropUsd: 2, recordedUsd: 2 });
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  /** The blocker this job exists for: imei24 charges 10x what the catalogue (and the cap) say. */
  it('alerts when a silent reprice drains 10x what we recorded', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    const metrics = new Metrics(false);
    const { log, lines } = recorder();
    await reconcileBalances({ providers: [supplier], repos, metrics, log, now: () => t0 });
    for (let i = 0; i < 20; i += 1) await spend(repos, 0.1, new Date(t0.getTime() + 60_000 * (i + 1)));
    supplier.balance = 80; // 20 calls at $1.00, recorded as 20 at $0.10

    const out = await reconcileBalances({ providers: [supplier], repos, metrics, log, now: () => t1 });
    expect(out.results[0]).toMatchObject({ status: 'drift', observedDropUsd: 20, recordedUsd: 2 });
    expect(lines.some((l) => l.level === 'error' && l.message.includes('more than our recorded spend'))).toBe(true);
    expect(await metrics.render()).toContain('imei_provider_balance_drift_total{provider_id="imei24"} 1');
  });

  it('only counts spend inside the window since the previous snapshot', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    const { log } = recorder();
    await spend(repos, 50, new Date(t0.getTime() - 60_000)); // before the window: must not excuse a drop
    await reconcileBalances({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    supplier.balance = 90;
    const out = await reconcileBalances({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t1 });
    expect(out.results[0]).toMatchObject({ status: 'drift', recordedUsd: 0 });
  });

  it('treats a rise as a top-up, not as reconciled', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    const { log, lines } = recorder();
    await reconcileBalances({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    supplier.balance = 150;
    const out = await reconcileBalances({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t1 });
    expect(out.results[0]?.status).toBe('top_up');
    expect(lines.some((l) => l.message.includes('cannot be reconciled'))).toBe(true);
  });

  it('writes no snapshot, and reports incomplete, when the balance cannot be read', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    supplier.balance = undefined;
    const { log } = recorder();
    let out = await reconcileBalances({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    expect(out).toMatchObject({ complete: false, results: [{ status: 'no_balance' }] });
    supplier.reachable = false;
    out = await reconcileBalances({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    expect(out).toMatchObject({ complete: false, results: [{ status: 'unreachable' }] });
    expect(repos.balances.rows).toEqual([]);
  });

  it('alerts when the balance runs out in under three days at the trailing burn rate', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    supplier.balance = 10;
    for (let d = 0; d < 3; d += 1) await spend(repos, 6, new Date(t0.getTime() - d * 86_400_000 - 1000));
    const metrics = new Metrics(false);
    const { log, lines } = recorder();
    const out = await reconcileBalances({ providers: [supplier], repos, metrics, log, now: () => t0 });
    expect(out.results[0]?.runwayDays).toBeCloseTo(10 / 6);
    expect(lines.some((l) => l.level === 'error' && l.message.includes('top up'))).toBe(true);
  });
});

describe('catalogue drift', () => {
  it('leaves a service alone when the live price matches', async () => {
    const repos = new MemoryRepositories();
    const { log, lines } = recorder();
    const out = await detectCatalogueDrift({ providers: [new FakeSupplier()], repos, metrics: new Metrics(false), log, now: () => t0 });
    expect(out).toEqual({ findings: [], complete: true });
    expect(await repos.serviceOverrides.list()).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('disables a repriced service, and the guard then refuses to buy it', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    supplier.prices = new Map([['486', 1.0]]);
    const metrics = new Metrics(false);
    const { log, lines } = recorder();

    const out = await detectCatalogueDrift({ providers: [supplier], repos, metrics, log, now: () => t0 });
    expect(out.findings).toEqual([
      { providerId: 'imei24', serviceId: '486', direction: 'up', cataloguePriceUsd: 0.1, livePriceUsd: 1 },
    ]);
    expect(await repos.serviceOverrides.isDisabled('imei24', '486')).toBe(true);
    expect(lines.some((l) => l.level === 'error')).toBe(true);
    expect(await metrics.render()).toContain('imei_services_disabled{provider_id="imei24"} 1');

    const guarded = new GuardedProvider(supplier, {
      lock: repos.locks,
      lockWaitMs: 100,
      dailySpendUsd: 10,
      costSince: async () => 0,
      isDisabled: (id, serviceId) => repos.serviceOverrides.isDisabled(id, serviceId),
    });
    const outcome = await guarded.execute({
      capability: 'blacklist.gsma',
      service: service('486', 0.1),
      imeiDigits: 'x',
      signal: AbortSignal.timeout(1000),
      referenceId: 'r',
    });
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'service_disabled', notSent: true });
    expect(supplier.calls).toBe(0);
  });

  it('disables a service that vanished from the supplier list', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier([service('486', 0.1), service('690', 0.12)]);
    const { log } = recorder();
    await detectCatalogueDrift({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    expect(await repos.serviceOverrides.list()).toMatchObject([
      { serviceId: '690', reason: 'missing_from_supplier_list', livePriceUsd: undefined },
    ]);
  });

  it('only warns when a price went down (overstated spend is the safe direction)', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    supplier.prices = new Map([['486', 0.05]]);
    const { log, lines } = recorder();
    const out = await detectCatalogueDrift({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    expect(out.findings[0]?.direction).toBe('down');
    expect(await repos.serviceOverrides.list()).toEqual([]);
    expect(lines.map((l) => l.level)).toEqual(['warn']);
  });

  /** A format change on their side must never switch the whole catalogue off. */
  it('disables nothing when the price list cannot be read', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    supplier.prices = undefined;
    const { log, lines } = recorder();
    const out = await detectCatalogueDrift({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    expect(out.complete).toBe(false);
    expect(await repos.serviceOverrides.list()).toEqual([]);
    expect(lines[0]?.level).toBe('error');
  });

  it('skips services the catalogue already disables', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier([service('486', 0.1), service('999', 0.1, false)]);
    const { log } = recorder();
    await detectCatalogueDrift({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    expect(await repos.serviceOverrides.list()).toEqual([]);
  });

  it('never re-enables on its own when the price comes back', async () => {
    const repos = new MemoryRepositories();
    const supplier = new FakeSupplier();
    supplier.prices = new Map([['486', 1.0]]);
    const { log } = recorder();
    await detectCatalogueDrift({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t0 });
    supplier.prices = new Map([['486', 0.1]]);
    await detectCatalogueDrift({ providers: [supplier], repos, metrics: new Metrics(false), log, now: () => t1 });
    expect(await repos.serviceOverrides.isDisabled('imei24', '486')).toBe(true);
  });
});
