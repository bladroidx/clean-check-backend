import { describe, expect, it } from 'vitest';
import type { CheckReport } from '@imei-check/contract';
import { Imei } from '@imei-check/identity';
import { MemoryRepositories, coverageFor, pollDueOrders } from '@imei-check/core';
import type { CatalogueService, ExecuteRequest, ProviderOutcome } from '@imei-check/providers';
import { CLEAN, FakeProvider, PEPPER, idempotencyKey, makePaidApp, service } from './paid-helpers.js';
import { SENTINEL, UNKNOWN_TAC_IMEI } from './helpers.js';

const post = (h: Awaited<ReturnType<typeof makePaidApp>>, url: string, body: unknown, key = idempotencyKey()) =>
  h.app.inject({ method: 'POST', url, headers: { ...h.auth(), 'idempotency-key': key }, payload: body as Record<string, unknown> });

describe('free /v1/checks', () => {
  it('answers identity.model and never touches a provider', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const h = await makePaidApp({ providers: [provider] });
    const res = await post(h, '/v1/checks', { imei: SENTINEL });
    expect(res.statusCode).toBe(200);
    const report = res.json<CheckReport>();
    expect(Object.keys(report.sections)).toEqual(['identity.model']);
    expect(provider.executed).toEqual([]);
  });

  it('a paid capability is unavailable(requires_deep_check), not dropped', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const h = await makePaidApp({ providers: [provider] });
    const report = (await post(h, '/v1/checks', { imei: SENTINEL, capabilities: ['identity.model', 'blacklist.gsma'] })).json<CheckReport>();
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'unavailable', reason: 'requires_deep_check' });
    expect(provider.executed).toEqual([]);
  });
});

describe('paid /v1/deep_checks', () => {
  it('defaults to blacklist only', async () => {
    const h = await makePaidApp();
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(Object.keys(report.sections)).toEqual(['blacklist.gsma']);
  });

  it('refuses identity.model with 400', async () => {
    const h = await makePaidApp();
    const res = await post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['identity.model'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('capability_not_in_tier');
  });

  it('an unknown TAC still gets the wildcard blacklist service', async () => {
    const h = await makePaidApp();
    const res = await post(h, '/v1/deep_checks', { imei: UNKNOWN_TAC_IMEI });
    expect(res.json<CheckReport>().sections['blacklist.gsma']?.outcome).toBe('pass');
  });

  it('the same idempotency key on both routes is not a conflict', async () => {
    const h = await makePaidApp();
    const key = idempotencyKey();
    expect((await post(h, '/v1/checks', { imei: SENTINEL }, key)).statusCode).toBe(200);
    expect((await post(h, '/v1/deep_checks', { imei: SENTINEL }, key)).statusCode).toBe(200);
  });

  it('GET routes only return their own tier', async () => {
    const h = await makePaidApp();
    const free = (await post(h, '/v1/checks', { imei: SENTINEL })).json<CheckReport>();
    const deep = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    const get = (url: string) => h.app.inject({ method: 'GET', url, headers: h.auth() });
    expect((await get(`/v1/deep_checks/${free.check_id}`)).statusCode).toBe(404);
    expect((await get(`/v1/checks/${deep.check_id}`)).statusCode).toBe(404);
    expect((await get(`/v1/deep_checks/${deep.check_id}`)).statusCode).toBe(200);
  });

  it('requesting warranty.status also fetches warranty.purchase_date', async () => {
    const provider = new FakeProvider('fake', { kind: 'answered', fields: [{ field: 'warranty.purchase_date', value: '2024-01-02T00:00:00.000Z' }], misses: [] },
      [service({ providerId: 'fake', serviceId: 'w', capabilities: ['warranty.purchase_date'], fields: ['warranty.purchase_date'] })]);
    const h = await makePaidApp({ providers: [provider] });
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['warranty.status'] })).json<CheckReport>();
    expect(Object.keys(report.sections).sort()).toEqual(['warranty.purchase_date', 'warranty.status']);
    expect(report.sections['warranty.status']?.outcome).not.toBe('unavailable');
  });
});

describe('wait window and hand-off', () => {
  it('a pending order that answers inside the window is returned final', async () => {
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'o1' },
      [service({ providerId: 'fake', async: true })]);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'o1' }, { kind: 'answered', fields: [{ field: 'blacklist.status', value: 'clean' }], misses: [] }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 2000, pollIntervalMs: 10 });
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(report.sections['blacklist.gsma']?.outcome).toBe('pass');
    expect(report.status).toBe('complete');
  });

  it('a still-pending order is inconclusive(awaiting_provider) and GET later reflects the worker', async () => {
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'o2' }, [service({ providerId: 'fake', async: true })]);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'o2' }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 50, pollIntervalMs: 10 });
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'inconclusive', reason: 'awaiting_provider' });
    expect(report.status).toBe('partial');

    // R12: the in-window polls left the worker's schedule exactly as placed.
    const [row] = await h.repos.orders.openForCheck(report.check_id);
    expect(row?.attempts).toBe(0);
    expect(row?.nextPollAt?.getTime()).toBe(Date.parse(report.requested_at) + 5 * 60 * 1000);

    // The worker's next pass, once the order is due, gets the answer...
    provider.pollOutcomes = [CLEAN];
    const summary = await pollDueOrders({
      repos: h.repos,
      providers: h.services.providers,
      tacDirectory: h.app.tacDirectory,
      metrics: h.services.metrics,
      now: () => new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(summary.answered).toBe(1);

    // ...and GET reflects it without calling the supplier.
    const executedBefore = provider.executed.length;
    const fetched = await h.app.inject({ method: 'GET', url: `/v1/deep_checks/${report.check_id}`, headers: h.auth() });
    expect(fetched.statusCode).toBe(200);
    const later = fetched.json<CheckReport>();
    expect(later.sections['blacklist.gsma']?.outcome).toBe('pass');
    expect(later.status).toBe('complete');
    expect(later.summary.reasons.length).toBeGreaterThan(0);
    expect(provider.executed).toHaveLength(executedBefore);
  });

  it('a second deep check for the same IMEI attaches to the open order instead of placing another', async () => {
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'o3' }, [service({ providerId: 'fake', async: true })]);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'o3' }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 50, pollIntervalMs: 10 });
    const first = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    const calls = (h.repos as MemoryRepositories).providerCalls.rows;
    expect(calls.size).toBe(1);
    const second = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(provider.executed).toHaveLength(1);
    // Attaching spends nothing, so it records no spend either.
    expect(calls.size).toBe(1);
    expect(second.sections['blacklist.gsma']).toMatchObject({ outcome: 'inconclusive', reason: 'awaiting_provider' });
    const attached = await h.repos.orders.openForCheck(second.check_id);
    expect(attached).toHaveLength(1);
    expect(attached[0]?.orderReference).toBe('o3');
    expect(attached[0]?.checkId).not.toBe(first.check_id);
  });
});

const imeiHash = (() => {
  const parsed = Imei.parse(SENTINEL);
  if (parsed.kind !== 'valid') throw new Error('sentinel must be valid');
  return parsed.imei.hmac(PEPPER);
})();

const BOTH = service({
  providerId: 'fake',
  serviceId: 'all-in-one',
  capabilities: ['blacklist.gsma', 'lock.activation'],
  fields: ['blacklist.status', 'lock.activation.status'],
});

describe('one call, several capabilities', () => {
  it('a pending multi-capability call inserts one order row per capability, sharing orderReference and imeiHash', async () => {
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'm1' }, [{ ...BOTH, async: true }]);
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 50, pollIntervalMs: 10 });
    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['blacklist.gsma', 'lock.activation'] })).json<CheckReport>();

    expect(provider.executed).toHaveLength(1);
    const rows = await h.repos.orders.openForCheck(report.check_id);
    expect(rows.map((r) => r.capability).sort()).toEqual(['blacklist.gsma', 'lock.activation']);
    expect(new Set(rows.map((r) => r.orderReference))).toEqual(new Set(['m1']));
    expect(new Set(rows.map((r) => r.imeiHash))).toEqual(new Set([imeiHash]));
    // `reference_id` is UNIQUE in Postgres.
    expect(new Set(rows.map((r) => r.referenceId)).size).toBe(2);
    // Spec section 5: the worker abandons after 30 minutes.
    for (const row of rows) expect(row.expiresAt.getTime()).toBe(Date.parse(report.requested_at) + 30 * 60 * 1000);
  });

  it('an answered multi-capability call buys once and writes the cache once per owning capability', async () => {
    const provider = new FakeProvider('fake', {
      kind: 'answered',
      fields: [
        { field: 'blacklist.status', value: 'clean' },
        { field: 'lock.activation.status', value: 'off' },
      ],
      misses: [],
    }, [BOTH]);
    const h = await makePaidApp({ providers: [provider] });
    const writes: string[][] = [];
    const write = h.services.cache.write.bind(h.services.cache);
    h.services.cache.write = async (args) => {
      writes.push(args.fields.map((f) => f.field));
      return write(args);
    };

    await post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['blacklist.gsma', 'lock.activation'] });

    expect(provider.executed).toHaveLength(1);
    expect(writes.sort()).toEqual([['blacklist.status'], ['lock.activation.status']]);
    expect((await h.repos.cache.get(`${imeiHash}:blacklist.status`))?.coverage).toEqual(coverageFor('blacklist.gsma', h.app.tacDirectory));
    expect((await h.repos.cache.get(`${imeiHash}:lock.activation.status`))?.coverage).toEqual(coverageFor('lock.activation', h.app.tacDirectory));
  });
});

/** Waits `ms`, or returns early (true) when `signal` aborts -- as a real HTTP transport does. */
function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
}

/** A supplier slower than the budget, that honours the abort signal like a real transport. */
class SlowProvider extends FakeProvider {
  constructor(
    id: string,
    outcome: ProviderOutcome,
    services: CatalogueService[],
    private readonly executeMs: number,
    private readonly pollMs = 0,
  ) {
    super(id, outcome, services);
  }
  override async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
    this.executed.push(request);
    if (await waitOrAbort(this.executeMs, request.signal)) return { kind: 'failed', reason: 'timeout' };
    return this.outcome;
  }
  override async poll(_ref?: string, _service?: CatalogueService, signal?: AbortSignal): Promise<ProviderOutcome> {
    if (await waitOrAbort(this.pollMs, signal)) return { kind: 'failed', reason: 'timeout' };
    return this.pollOutcomes[0] ?? this.outcome;
  }
}

const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
};

describe('the deep-check time budget (R10/R11)', () => {
  const BUDGET = 300;
  const MARGIN = 400;

  it('a supplier slower than the budget cannot hold the POST past it', async () => {
    const provider = new SlowProvider('fake', CLEAN, [service({ providerId: 'fake' })], 5_000);
    const h = await makePaidApp({ providers: [provider], deepWaitMs: BUDGET });
    const { value, ms } = await timed(() => post(h, '/v1/deep_checks', { imei: SENTINEL }));
    expect(ms).toBeLessThan(BUDGET + MARGIN);
    expect(value.statusCode).toBe(200);
    expect(value.json<CheckReport>().sections['blacklist.gsma']?.outcome).toBe('unavailable');
  });

  it('a poll slower than the budget cannot hold the POST past it', async () => {
    const provider = new SlowProvider('fake', { kind: 'pending', orderReference: 'p1' }, [service({ providerId: 'fake', async: true })], 0, 5_000);
    const h = await makePaidApp({ providers: [provider], deepWaitMs: BUDGET, pollIntervalMs: 10 });
    const { value, ms } = await timed(() => post(h, '/v1/deep_checks', { imei: SENTINEL }));
    expect(ms).toBeLessThan(BUDGET + MARGIN);
    expect(value.json<CheckReport>().sections['blacklist.gsma']).toMatchObject({ outcome: 'inconclusive', reason: 'awaiting_provider' });
  });

  it('a supplier lock held by another process cannot hold the POST past it', async () => {
    const h = await makePaidApp({ deepWaitMs: BUDGET });
    let release: () => void = () => {};
    const holder = h.repos.locks.withLock('provider:fake', 5_000, () => new Promise<void>((r) => { release = r; }));
    const { value, ms } = await timed(() => post(h, '/v1/deep_checks', { imei: SENTINEL }));
    release();
    await holder;
    expect(ms).toBeLessThan(BUDGET + MARGIN);
    expect(value.json<CheckReport>().sections['blacklist.gsma']?.outcome).toBe('unavailable');
  });

  it('once the budget is spent the next call is not placed at all', async () => {
    const provider = new SlowProvider('fake', CLEAN, [
      service({ providerId: 'fake', serviceId: 'bl', costUsd: 0.1 }),
      service({ providerId: 'fake', serviceId: 'al', capabilities: ['lock.activation'], fields: ['lock.activation.status'], costUsd: 0.5 }),
    ], 5_000);
    const h = await makePaidApp({ providers: [provider], deepWaitMs: BUDGET });
    const { value, ms } = await timed(() => post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['blacklist.gsma', 'lock.activation'] }));
    expect(ms).toBeLessThan(BUDGET + MARGIN);
    expect(provider.executed).toHaveLength(1);
    expect(value.json<CheckReport>().sections['lock.activation']).toMatchObject({
      outcome: 'unavailable',
      reason: 'provider_timeout',
      detail: 'Not attempted: the deep-check time budget was spent.',
    });
    // Nothing placed means nothing recorded as spend.
    expect((h.repos as MemoryRepositories).providerCalls.rows.size).toBe(1);
  });

  it('the window counts from request start, not from when the order was placed', async () => {
    // Placing takes 500 ms; the budget is 700 ms. Counting from placement would return at ~1200.
    const provider = new SlowProvider('fake', { kind: 'pending', orderReference: 'p2' }, [service({ providerId: 'fake', async: true })], 500);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'p2' }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 700, pollIntervalMs: 10 });
    const { value, ms } = await timed(() => post(h, '/v1/deep_checks', { imei: SENTINEL }));
    expect(ms).toBeLessThan(1_000);
    expect(value.json<CheckReport>().status).toBe('partial');
  });
});

describe('IMEI encryption at rest (ADR-0007)', () => {
  it('a free and a deep check both store an IMEI that decrypts to the sentinel', async () => {
    const h = await makePaidApp();

    const free = (await post(h, '/v1/checks', { imei: SENTINEL })).json<CheckReport>();
    const deep = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();

    for (const checkId of [free.check_id, deep.check_id]) {
      const stored = await h.repos.checks.encryptedImei(checkId);
      expect(stored).toBeDefined();
      expect(h.services.cipher.decrypt(stored!.imeiEncrypted, stored!.imeiKeyVersion, checkId)).toBe(SENTINEL);
    }
  });
});

describe('the daily spend cap counts what may have been spent (R18)', () => {
  it('a timed-out order is spend: the next order past the cap is refused, not placed', async () => {
    // 6 USD a call against the default 10 USD cap. At 0 per timeout (the old behaviour) every
    // retry would sail under the cap while the supplier kept debiting us for orders it had placed.
    const provider = new FakeProvider('fake', { kind: 'failed', reason: 'timeout' }, [service({ providerId: 'fake', costUsd: 6 })]);
    const h = await makePaidApp({ providers: [provider] });

    const first = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(first.sections['blacklist.gsma']).toMatchObject({ outcome: 'unavailable', reason: 'provider_timeout' });

    const second = (await post(h, '/v1/deep_checks', { imei: SENTINEL })).json<CheckReport>();
    expect(second.sections['blacklist.gsma']).toMatchObject({ outcome: 'unavailable', reason: 'spend_cap_reached' });
    expect(provider.executed).toHaveLength(1);
  });
});

/**
 * Final review F2 / ruling R17: the in-flight dedupe race.
 *
 * `openForImei` and the cache are read before the supplier's one-job lock is taken, so two deep
 * checks for the same device arriving together both saw "nothing open, nothing cached", queued on
 * the lock, and each placed its own order -- imei24 charges for every repeat. The re-check now runs
 * inside the lock, immediately before sending, and whatever the first one bought is persisted
 * before the lock is released.
 */
describe('concurrent deep checks for one IMEI (R17)', () => {
  const spent = (h: Awaited<ReturnType<typeof makePaidApp>>) =>
    [...(h.repos as MemoryRepositories).providerCalls.rows.values()].reduce((sum, r) => sum + r.providerCostUsd, 0);

  it('two concurrent async checks place ONE order and both attach to it', async () => {
    const provider = new SlowProvider('fake', { kind: 'pending', orderReference: 'race-1' }, [service({ providerId: 'fake', async: true })], 100);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'race-1' }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 1_000, pollIntervalMs: 50 });

    const [a, b] = (await Promise.all([
      post(h, '/v1/deep_checks', { imei: SENTINEL }),
      post(h, '/v1/deep_checks', { imei: SENTINEL }),
    ])).map((r) => r.json<CheckReport>());

    expect(provider.executed).toHaveLength(1);
    expect(spent(h)).toBeCloseTo(0.1);
    for (const report of [a, b]) {
      expect(report?.sections['blacklist.gsma']).toMatchObject({ outcome: 'inconclusive', reason: 'awaiting_provider' });
      const rows = await h.repos.orders.openForCheck(report!.check_id);
      expect(rows.map((r) => r.orderReference)).toEqual(['race-1']);
    }
  });

  it('two concurrent sync checks buy ONCE; the second is served from the cache the first wrote', async () => {
    const provider = new SlowProvider('fake', CLEAN, [service({ providerId: 'fake' })], 100);
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 1_000 });

    const reports = (await Promise.all([
      post(h, '/v1/deep_checks', { imei: SENTINEL }),
      post(h, '/v1/deep_checks', { imei: SENTINEL }),
    ])).map((r) => r.json<CheckReport>());

    expect(provider.executed).toHaveLength(1);
    expect(spent(h)).toBeCloseTo(0.1);
    const sections = reports.map((r) => r.sections['blacklist.gsma']);
    expect(sections.map((s) => s?.outcome)).toEqual(['pass', 'pass']);
    // Exactly one of them is the cached answer, with the ORIGINAL checked_at (ADR-0004).
    expect(sections.filter((s) => s?.freshness?.cached === true)).toHaveLength(1);
  });
});

describe('settling after the POST (final review F4, F5)', () => {
  const worker = (h: Awaited<ReturnType<typeof makePaidApp>>) =>
    pollDueOrders({
      repos: h.repos,
      providers: h.services.providers,
      tacDirectory: h.app.tacDirectory,
      metrics: h.services.metrics,
      now: () => new Date(Date.now() + 6 * 60 * 1000),
    });
  const get = async (h: Awaited<ReturnType<typeof makePaidApp>>, id: string) =>
    (await h.app.inject({ method: 'GET', url: `/v1/deep_checks/${id}`, headers: h.auth() })).json<CheckReport>();

  it('warranty.status waits for a pending purchase date, then is derived from it', async () => {
    // Every imei24 purchase-date service is async, so this is the normal deep-route shape.
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'w1' }, [
      service({ providerId: 'fake', serviceId: 'w', async: true, capabilities: ['warranty.purchase_date'], fields: ['warranty.purchase_date'] }),
    ]);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'w1' }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 50, pollIntervalMs: 10 });

    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['warranty.status'] })).json<CheckReport>();
    // Not "capability_not_supported_for_device": the fact it is derived from is on its way.
    expect(report.sections['warranty.status']).toMatchObject({ outcome: 'inconclusive', reason: 'awaiting_provider', remedy: 'retry_later' });
    expect(report.status).toBe('partial');

    const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    provider.pollOutcomes = [{ kind: 'answered', fields: [{ field: 'warranty.purchase_date', value: recent }], misses: [] }];
    await worker(h);

    const later = await get(h, report.check_id);
    expect(later.sections['warranty.purchase_date']?.outcome).toBe('pass');
    expect(later.sections['warranty.status']).toMatchObject({ outcome: 'pass' });
    expect(later.status).toBe('complete');
    expect(later.summary.verdict).toBe('green');
  });

  it('a fail that lands while another order is still pending turns the verdict red at once', async () => {
    const blacklist = new FakeProvider('fa', { kind: 'pending', orderReference: 'a1' }, [service({ providerId: 'fa', serviceId: 'bl', async: true })]);
    blacklist.pollOutcomes = [{ kind: 'answered', fields: [{ field: 'blacklist.status', value: 'blocked' }], misses: [] }];
    const lock = new FakeProvider('fb', { kind: 'pending', orderReference: 'b1' }, [
      service({ providerId: 'fb', serviceId: 'al', async: true, capabilities: ['lock.activation'], fields: ['lock.activation.status'] }),
    ]);
    lock.pollOutcomes = [{ kind: 'pending', orderReference: 'b1' }];
    const h = await makePaidApp({ providers: [blacklist, lock], deepWaitMs: 300, pollIntervalMs: 10 });

    const report = (await post(h, '/v1/deep_checks', { imei: SENTINEL, capabilities: ['blacklist.gsma', 'lock.activation'] })).json<CheckReport>();
    expect(report.sections['blacklist.gsma']?.outcome).toBe('fail');
    expect(report.status).toBe('partial');
    // A `fail` under an amber summary is the one inconsistency a buyer must never see.
    expect(report.summary.verdict).toBe('red');
    expect((await get(h, report.check_id)).summary.verdict).toBe('red');
  });
});
