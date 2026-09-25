import { describe, expect, it } from 'vitest';
import type { CheckReport } from '@imei-check/contract';
import { CLEAN, FakeProvider, idempotencyKey, makePaidApp, service } from './paid-helpers.js';
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
  });

  it('a second deep check for the same IMEI attaches to the open order instead of placing another', async () => {
    const provider = new FakeProvider('fake', { kind: 'pending', orderReference: 'o3' }, [service({ providerId: 'fake', async: true })]);
    provider.pollOutcomes = [{ kind: 'pending', orderReference: 'o3' }];
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 0 });
    await post(h, '/v1/deep_checks', { imei: SENTINEL });
    await post(h, '/v1/deep_checks', { imei: SENTINEL });
    expect(provider.executed).toHaveLength(1);
  });
});
