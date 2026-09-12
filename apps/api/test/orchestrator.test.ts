import { describe, expect, it } from 'vitest';
import type { CheckReport } from '@imei-check/contract';
import type { ProviderOutcome } from '@imei-check/providers';
import { CLEAN, FakeProvider, idempotencyKey, makePaidApp, service } from './paid-helpers.js';
import { SENTINEL } from './helpers.js';

/**
 * Orchestration paths that are not the happy one.
 *
 * The abuse ladder, the async order lifecycle, derived capabilities and the offline tier all sit
 * inside `runCheck`, and each of them can turn an honest answer into a misleading one if it takes
 * the wrong branch.
 */

function post(
  harness: Awaited<ReturnType<typeof makePaidApp>>,
  body: unknown,
  key = idempotencyKey(),
) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/checks',
    headers: { ...harness.auth(), 'idempotency-key': key },
    payload: body as Record<string, unknown>,
  });
}

const APPLE_SERVICE = service({
  providerId: 'fake',
  serviceId: 'apple',
  capabilities: ['lock.activation', 'warranty.purchase_date'],
  fields: ['lock.activation.status', 'warranty.purchase_date'],
  lexiconId: 'apple-basic',
  credits: 8,
});

describe('the offline tier inside a paid check', () => {
  it('answers identity.model from the TAC directory, free, without a provider', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const harness = await makePaidApp({ providers: [provider], credits: 100 });

    const report = (await post(harness, { imei: SENTINEL, capabilities: ['identity.model'] })).json<CheckReport>();

    expect(report.sections['identity.model']?.outcome).toBe('pass');
    expect(report.billing.credits_charged).toBe(0);
    // Buying an answer we already hold is pure waste.
    expect(provider.executed).toEqual([]);
  });

  it('an unknown TAC is inconclusive, never a pass', async () => {
    const harness = await makePaidApp({ credits: 100 });
    const report = (
      await post(harness, { imei: '999999990000008', capabilities: ['identity.model'] })
    ).json<CheckReport>();

    expect(report.sections['identity.model']?.outcome).toBe('inconclusive');
    expect(report.sections['identity.model']?.reason).toBe('device_not_found_in_registry');
    expect(report.summary.verdict).not.toBe('green');
  });
});

describe('derived capabilities', () => {
  it('derives warranty.status from a purchase date without buying it', async () => {
    const recent = new Date();
    recent.setUTCMonth(recent.getUTCMonth() - 3);
    const outcome: ProviderOutcome = {
      kind: 'answered',
      fields: [{ field: 'warranty.purchase_date', value: recent.toISOString() }],
      misses: [],
    };
    const harness = await makePaidApp({
      providers: [new FakeProvider('fake', outcome, [APPLE_SERVICE])],
      credits: 100,
    });

    const report = (
      await post(harness, { imei: SENTINEL, capabilities: ['warranty.purchase_date', 'warranty.status'] })
    ).json<CheckReport>();

    expect(report.sections['warranty.status']?.outcome).toBe('pass');
    // The single largest saving in the design: a recurring paid lookup becomes arithmetic.
    const derived = report.billing.breakdown.find((b) => b.capability === 'warranty.status');
    expect(derived?.credits).toBe(0);
  });

  it('is unavailable, not pass, when no purchase date was obtained', async () => {
    const harness = await makePaidApp({
      providers: [new FakeProvider('fake', { kind: 'failed', reason: 'timeout' }, [APPLE_SERVICE])],
      credits: 100,
    });

    const report = (
      await post(harness, { imei: SENTINEL, capabilities: ['warranty.status'] })
    ).json<CheckReport>();

    expect(report.sections['warranty.status']?.outcome).toBe('unavailable');
  });
});

describe('async orders', () => {
  it('records a pending order and reports the check as partial', async () => {
    const harness = await makePaidApp({
      providers: [
        new FakeProvider('fake', { kind: 'pending', orderReference: 'sup-1' }, [APPLE_SERVICE]),
      ],
      credits: 100,
    });

    const report = (
      await post(harness, { imei: SENTINEL, capabilities: ['lock.activation'] })
    ).json<CheckReport>();

    expect(report.status).toBe('partial');
    expect(report.completed_at).toBeNull();
    expect(report.sections['lock.activation']?.reason).toBe('awaiting_provider');

    const open = await harness.repos.orders.openForCheck(report.check_id);
    expect(open).toHaveLength(1);
    expect(open[0]?.orderReference).toBe('sup-1');
  });
});

describe('the abuse ladder', () => {
  it('cache_only serves a cached answer and buys nothing new', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const harness = await makePaidApp({ providers: [provider], credits: 100 });

    // Warm the cache while unrestricted.
    await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });
    expect(provider.executed).toHaveLength(1);

    await harness.repos.abuse.restrict('ten_test', 'cache_only', 'test');

    const cached = (await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })).json<CheckReport>();
    expect(cached.sections['blacklist.gsma']?.outcome).toBe('pass');
    expect(cached.sections['blacklist.gsma']?.freshness.cached).toBe(true);

    // A device with nothing cached gets an honest unavailable rather than a paid call.
    const uncached = (
      await post(harness, { imei: '356920051234564', capabilities: ['blacklist.gsma'] })
    ).json<CheckReport>();
    expect(uncached.sections['blacklist.gsma']?.outcome).toBe('unavailable');
    // The rung costs us nothing and still answers, which is what makes a false positive cheap.
    expect(provider.executed).toHaveLength(1);
  });

  it('no_paid blocks spend but still returns a well-formed report', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const harness = await makePaidApp({ providers: [provider], credits: 100 });
    await harness.repos.abuse.restrict('ten_test', 'no_paid', 'test');

    const response = await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });

    expect(response.statusCode).toBe(200);
    expect(response.json<CheckReport>().sections['blacklist.gsma']?.outcome).toBe('unavailable');
    expect(provider.executed).toEqual([]);
    expect(await harness.repos.credits.balance('ten_test')).toBe(100);
  });

  it('suspended refuses the request outright', async () => {
    const harness = await makePaidApp({ credits: 100 });
    await harness.repos.abuse.restrict('ten_test', 'suspended', 'test');

    const response = await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('account_restricted');
  });
});

describe('capabilities preview', () => {
  it('prices a device without spending anything', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const harness = await makePaidApp({ providers: [provider], credits: 100 });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/capabilities',
      headers: harness.auth(),
      payload: { imei: SENTINEL },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.capabilities.find((c: { capability: string }) => c.capability === 'blacklist.gsma')).toMatchObject({
      available: true,
      credits: 3,
    });
    // identity.model and warranty.status are free: offline and derived respectively.
    expect(body.capabilities.find((c: { capability: string }) => c.capability === 'identity.model')?.credits).toBe(0);
    expect(provider.executed).toEqual([]);
    expect(await harness.repos.credits.balance('ten_test')).toBe(100);
  });

  it('rejects an invalid IMEI', async () => {
    const harness = await makePaidApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/capabilities',
      headers: harness.auth(),
      payload: { imei: 'not an imei' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('balance and ledger', () => {
  it('shows what was charged and why, in the billing vocabulary', async () => {
    const harness = await makePaidApp({ credits: 100 });
    await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/balance',
      headers: harness.auth(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.credits_remaining).toBe(97);
    expect(body.recent.map((e: { reason: string }) => e.reason)).toContain('reserve');
  });

  it('exposes Prometheus metrics including the drift alarm', async () => {
    const harness = await makePaidApp();
    const response = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('imei_lexicon_miss_total');
    expect(response.body).toContain('imei_absorbed_cost_usd_total');
  });
});
