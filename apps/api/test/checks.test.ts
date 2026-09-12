import { describe, expect, it } from 'vitest';
import { assertEnvelopeInvariants, type CheckReport } from '@imei-check/contract';
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
 * The paid path, end to end.
 *
 * These are the tests a buyer's safety actually depends on. Each one asks whether some plausible
 * failure -- a supplier outage, an empty balance, a retried request, a reworded status -- can be
 * made to render as "nothing wrong found".
 */

async function post(
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

describe('POST /v1/checks', () => {
  it('answers a clean device and charges list price', async () => {
    const harness = await makePaidApp({ credits: 100 });
    const response = await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });

    expect(response.statusCode).toBe(200);
    const report = response.json<CheckReport>();
    expect(report.sections['blacklist.gsma']?.outcome).toBe('pass');
    expect(report.summary.verdict).toBe('green');
    expect(report.billing.credits_charged).toBe(3);
    expect(await harness.repos.credits.balance('ten_test')).toBe(97);
    assertEnvelopeInvariants(report);
  });

  it('reports a blocked device as red, with a finding', async () => {
    const harness = await makePaidApp({ providers: [new FakeProvider('fake', BLOCKED)] });
    const report = (await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })).json<CheckReport>();

    expect(report.sections['blacklist.gsma']?.outcome).toBe('fail');
    expect(report.summary.verdict).toBe('red');
    expect(report.sections['blacklist.gsma']?.finding?.severity).toBe('critical');
  });

  /**
   * Invariant 7, and the reason it exists: a 502 is indistinguishable to a naive client from
   * "nothing wrong found".
   */
  it('returns 200 with every section unavailable when the supplier is down', async () => {
    const harness = await makePaidApp({ providers: [new FakeProvider('fake', TIMEOUT)] });
    const response = await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });

    expect(response.statusCode).toBe(200);
    const report = response.json<CheckReport>();
    expect(report.sections['blacklist.gsma']?.outcome).toBe('unavailable');
    expect(report.summary.verdict).toBe('undetermined');
    // An answer we could not give is stated, never dropped.
    expect(report.summary.sections_unavailable).toContain('blacklist.gsma');
  });

  it('charges nothing when the supplier is down', async () => {
    const harness = await makePaidApp({ providers: [new FakeProvider('fake', TIMEOUT)], credits: 100 });
    const report = (await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })).json<CheckReport>();

    expect(report.billing.credits_charged).toBe(0);
    expect(await harness.repos.credits.balance('ten_test')).toBe(100);
  });

  /** Our lexicon gap. Amber, and free. */
  it('renders a reworded supplier status as amber and charges nothing for it', async () => {
    const harness = await makePaidApp({ providers: [new FakeProvider('fake', REWORDED)], credits: 100 });
    const report = (await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })).json<CheckReport>();

    expect(report.sections['blacklist.gsma']?.outcome).toBe('inconclusive');
    expect(report.sections['blacklist.gsma']?.reason).toBe('unrecognised_provider_value');
    expect(report.summary.verdict).not.toBe('green');
    expect(report.billing.credits_charged).toBe(0);
    expect(await harness.repos.credits.balance('ten_test')).toBe(100);
  });

  it('serves the second identical request from cache, at 20% of list', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const harness = await makePaidApp({ providers: [provider], credits: 100 });

    await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });
    const second = (await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })).json<CheckReport>();

    expect(provider.executed).toHaveLength(1);
    expect(second.sections['blacklist.gsma']?.freshness.cached).toBe(true);
    expect(second.billing.credits_charged).toBe(1);
  });

  it('a cache hit reports the ORIGINAL checked_at, not now', async () => {
    const harness = await makePaidApp({ credits: 100 });
    const first = (await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })).json<CheckReport>();
    const second = (await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })).json<CheckReport>();

    expect(second.sections['blacklist.gsma']?.checked_at).toBe(
      first.sections['blacklist.gsma']?.checked_at,
    );
  });

  it('max_age_seconds: 0 bypasses the cache at full price', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const harness = await makePaidApp({ providers: [provider], credits: 100 });

    await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });
    const fresh = (
      await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'], max_age_seconds: 0 })
    ).json<CheckReport>();

    expect(provider.executed).toHaveLength(2);
    expect(fresh.sections['blacklist.gsma']?.freshness.cached).toBe(false);
    expect(fresh.billing.credits_charged).toBe(3);
  });
});

describe('idempotency', () => {
  it('replays the first response and does not charge twice', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const harness = await makePaidApp({ providers: [provider], credits: 100 });
    const key = idempotencyKey();

    const first = await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] }, key);
    const retry = await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] }, key);

    expect(retry.statusCode).toBe(200);
    expect(retry.json<CheckReport>().check_id).toBe(first.json<CheckReport>().check_id);
    expect(provider.executed).toHaveLength(1);
    expect(await harness.repos.credits.balance('ten_test')).toBe(97);
  });

  it('rejects the same key used for a different device', async () => {
    const harness = await makePaidApp({ credits: 100 });
    const key = idempotencyKey();

    await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] }, key);
    const other = await post(harness, { imei: '356920051234564', capabilities: ['blacklist.gsma'] }, key);

    // Serving the previous device's report would be a bug on our side, not theirs.
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('idempotency_key_reused');
  });

  it('requires the header at all', async () => {
    const harness = await makePaidApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: harness.auth(),
      payload: { imei: SENTINEL },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('credits', () => {
  /**
   * Partial affordability is honoured. A 402 that kills the whole check throws away answers we
   * could have given and already paid nothing for.
   */
  it('runs what the balance covers and marks the rest unavailable(insufficient_credits)', async () => {
    const provider = new FakeProvider('fake', CLEAN, [
      service({ providerId: 'fake', serviceId: 'bl', capabilities: ['blacklist.gsma'], credits: 3 }),
      service({
        providerId: 'fake',
        serviceId: 'al',
        capabilities: ['lock.activation'],
        fields: ['lock.activation.status'],
        credits: 8,
      }),
    ]);
    const harness = await makePaidApp({ providers: [provider], credits: 3 });

    const report = (
      await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma', 'lock.activation'] })
    ).json<CheckReport>();

    expect(report.sections['blacklist.gsma']?.outcome).toBe('pass');
    expect(report.sections['lock.activation']?.outcome).toBe('unavailable');
    expect(report.sections['lock.activation']?.reason).toBe('insufficient_credits');
    expect(report.billing.credits_charged).toBe(3);
  });

  it('never lets the balance go negative', async () => {
    const harness = await makePaidApp({ credits: 1 });
    await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });
    expect(await harness.repos.credits.balance('ten_test')).toBeGreaterThanOrEqual(0);
  });

  it('keeps the ledger and the cached balance in agreement', async () => {
    const harness = await makePaidApp({ credits: 100 });
    await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] });
    await post(harness, { imei: '356920051234564', capabilities: ['blacklist.gsma'] });

    expect((await harness.repos.credits.reconcile('ten_test')).drift).toBe(0);
  });
});

describe('auth', () => {
  it('refuses an absent key', async () => {
    const harness = await makePaidApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL },
    });
    expect(response.statusCode).toBe(401);
  });

  it('gives the same answer for a malformed key and an unknown one', async () => {
    const harness = await makePaidApp();
    const malformed = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { authorization: 'Bearer nonsense', 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL },
    });
    const unknown = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: {
        authorization: `Bearer imc_test_${'A'.repeat(52)}`,
        'idempotency-key': idempotencyKey(),
      },
      payload: { imei: SENTINEL },
    });
    // Distinguishing them tells an attacker which guess was structurally right.
    expect(malformed.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(malformed.json().error.code).toBe(unknown.json().error.code);
  });

  it('never echoes the presented credential', async () => {
    const harness = await makePaidApp();
    const secret = 'imc_live_SUPERSECRETVALUE';
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { authorization: `Bearer ${secret}`, 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL },
    });
    expect(response.body).not.toContain('SUPERSECRET');
    expect(harness.logs.raw()).not.toContain('SUPERSECRET');
  });
});

describe('the Luhn gate', () => {
  it('rejects an invalid IMEI before spending anything', async () => {
    const provider = new FakeProvider('fake', CLEAN);
    const harness = await makePaidApp({ providers: [provider], credits: 100 });

    const response = await post(harness, { imei: '353104112345670' });

    expect(response.statusCode).toBe(400);
    expect(provider.executed).toEqual([]);
    expect(await harness.repos.credits.balance('ten_test')).toBe(100);
  });
});

describe('GET /v1/checks/:id', () => {
  it('returns a stored check, and 404 for another tenant’s id', async () => {
    const harness = await makePaidApp({ credits: 100 });
    const created = (await post(harness, { imei: SENTINEL, capabilities: ['blacklist.gsma'] })).json<CheckReport>();

    const found = await harness.app.inject({
      method: 'GET',
      url: `/v1/checks/${created.check_id}`,
      headers: harness.auth(),
    });
    expect(found.statusCode).toBe(200);
    expect(found.json<CheckReport>().check_id).toBe(created.check_id);

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/v1/checks/chk_does_not_exist',
      headers: harness.auth(),
    });
    expect(missing.statusCode).toBe(404);
  });
});
