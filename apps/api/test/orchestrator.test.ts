import { describe, expect, it } from 'vitest';
import type { CheckReport } from '@imei-check/contract';
import type { ProviderOutcome } from '@imei-check/providers';
import {
  BLOCKED,
  CLEAN,
  FakeProvider,
  REWORDED,
  TIMEOUT,
  idempotencyKey,
  makePaidApp,
  service,
} from './paid-helpers.js';
import { SENTINEL } from './helpers.js';

/**
 * Orchestration paths that are not the happy one.
 *
 * The async order lifecycle, derived capabilities and the offline tier all sit inside `runCheck`,
 * and each of them can turn an honest answer into a misleading one if it takes the wrong branch.
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
      credits: 0,
    });
    // identity.model and warranty.status are free: offline and derived respectively.
    expect(body.capabilities.find((c: { capability: string }) => c.capability === 'identity.model')?.credits).toBe(0);
    expect(provider.executed).toEqual([]);
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

describe('metrics', () => {
  it('exposes Prometheus metrics including the format-drift and absorbed-cost alarms', async () => {
    const harness = await makePaidApp();
    const response = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('imei_lexicon_miss_total');
    expect(response.body).toContain('imei_absorbed_cost_usd_total');
  });
});

/**
 * All four arms, with billing permanently off.
 *
 * There is no billing flag left to waive a charge -- there is no billing at all -- so what this
 * pins is that the arm selector still chooses correctly and every arm still charges nothing, none
 * of the four may ever report anything other than `credits_charged: 0`.
 */
const ARM_MATRIX = [
  ['clean', CLEAN, 'pass', undefined],
  ['blacklisted', BLOCKED, 'fail', undefined],
  ['reworded to an unknown phrase', REWORDED, 'inconclusive', 'unrecognised_provider_value'],
  ['supplier timeout', TIMEOUT, 'unavailable', 'provider_timeout'],
] as const;

describe('every arm charges nothing', () => {
  it.each(ARM_MATRIX)('%s -> %s', async (_label, outcome, arm, reason) => {
    const harness = await makePaidApp({ providers: [new FakeProvider('fake', outcome)] });

    const report = (
      await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })
    ).json<CheckReport>();
    const section = report.sections['blacklist.gsma'];

    expect(section?.outcome).toBe(arm);
    if (reason !== undefined) expect(section?.reason).toBe(reason);
    // `unavailable` and `inconclusive` still carry coverage and a checked_at, and `inconclusive`
    // still carries a remedy.
    expect(section?.coverage).toBeDefined();
    if (arm === 'inconclusive') expect(section?.remedy).toBeDefined();

    expect(report.billing.credits_charged).toBe(0);
    expect('credits_remaining' in report.billing).toBe(false);
  });
});
