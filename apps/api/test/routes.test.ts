import { afterEach, describe, expect, it } from 'vitest';
import { assertSectionInvariants } from '@imei-check/contract';
import type { App } from '../src/app.js';
import { SENTINEL, UNKNOWN_TAC_IMEI, makeApp } from './helpers.js';

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const validate = async (imei: string) => {
  const made = await makeApp();
  app = made.app;
  const res = await app.inject({ method: 'POST', url: '/v1/imei/validate', payload: { imei } });
  return { res, body: res.json(), logs: made.logs };
};

describe('POST /v1/imei/validate', () => {
  it('identifies a known device and carries its evidence and coverage', async () => {
    const { res, body } = await validate(SENTINEL);
    expect(res.statusCode).toBe(200);
    expect(body.subject.luhn_valid).toBe(true);
    expect(body.subject.tac).toBe('35310411');

    expect(body.identity.outcome).toBe('pass');
    expect(body.identity.evidence).toEqual([
      { type: 'text', label: 'Manufacturer', value: 'Apple' },
      { type: 'text', label: 'Model', value: 'iPhone 13' },
    ]);
    expect(body.identity.coverage.source_version).toBe('test-directory-1');
    expect(body.identity.coverage.caveats.length).toBeGreaterThan(0);
    expect(() => assertSectionInvariants(body.identity)).not.toThrow();
  });

  it('an unknown TAC is inconclusive, never a pass', async () => {
    // The directory not knowing a model is not evidence that the number is fine.
    const { body } = await validate(UNKNOWN_TAC_IMEI);
    expect(body.identity.outcome).toBe('inconclusive');
    expect(body.identity.reason).toBe('device_not_found_in_registry');
    expect(body.identity.remedy).toBeDefined();
    expect(() => assertSectionInvariants(body.identity)).not.toThrow();
  });

  it('never returns the full IMEI, only the mask', async () => {
    const { res, body } = await validate(SENTINEL);
    expect(res.body).not.toContain(SENTINEL);
    expect(body.subject.imei_masked).toBe('35•••••••••••76');
  });

  it('reports wrong_length distinctly from nothing_numeric', async () => {
    const short = await validate('12345');
    expect(short.body.parse.kind).toBe('wrong_length');
    expect(short.body.parse.digits_found).toBe(5);
    await app?.close();

    const none = await validate('no digits here');
    expect(none.body.parse.kind).toBe('nothing_numeric');
  });

  it('names which digit is wrong on a checksum failure, and still masks', async () => {
    const bad = await validate('353104112345670');
    expect(bad.body.parse.kind).toBe('checksum_failed');
    expect(bad.body.parse.expected_check_digit).toBe(6);
    expect(bad.body.parse.given_check_digit).toBe(0);
    expect(bad.res.body).not.toContain('353104112345670');
  });

  it('carries the disclaimer on every response, including rejections', async () => {
    const ok = await validate(SENTINEL);
    expect(ok.body.disclaimer).toMatch(/not proof/);
    await app?.close();
    const bad = await validate('12345');
    expect(bad.body.disclaimer).toMatch(/not proof/);
  });
});

describe('GET /v1/tac/:tac', () => {
  it('returns the device and its attribution', async () => {
    const made = await makeApp();
    app = made.app;
    const res = await app.inject({ method: 'GET', url: '/v1/tac/35847191' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      manufacturer: 'Samsung',
      model: 'SM-G991B',
      source_version: 'test-directory-1',
      attribution: 'test attribution',
    });
  });

  it('404s an unknown TAC and rejects a malformed one', async () => {
    const made = await makeApp();
    app = made.app;
    expect((await app.inject({ method: 'GET', url: '/v1/tac/00000000' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/tac/123' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/tac/abcdefgh' })).statusCode).toBe(400);
  });

  it('offers no bulk or wildcard listing', async () => {
    // A list endpoint would make us a redistributor of the compilation and hard-trigger CC-BY-SA
    // ShareAlike over our whole dataset. See docs/adr/0005-tac-data-licensing.md.
    const made = await makeApp();
    app = made.app;
    for (const url of ['/v1/tac', '/v1/tac/', '/v1/tacs']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('health', () => {
  it('healthz is ok and readyz reports its checks', async () => {
    const made = await makeApp();
    app = made.app;
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.tac_directory).toBe('ok');
  });

  it('readyz does not depend on any provider', async () => {
    // A supplier outage is a SectionResult, not an outage of this service. Wiring providers into
    // readiness makes the orchestrator restart healthy pods during someone else's incident.
    const made = await makeApp();
    app = made.app;
    const checks = (await app.inject({ method: 'GET', url: '/readyz' })).json().checks;
    expect(Object.keys(checks).some((k) => /provider|upstream|supplier/i.test(k))).toBe(false);
  });
});

describe('GET /v1/attributions', () => {
  it('names every data source and its licence', () => {
    // CC BY-SA's attribution requirement is satisfied here and in coverage.attribution. It costs
    // nothing and it is the difference between using Osmocom and infringing it (ADR-0005).
    return makeApp().then(async (made) => {
      app = made.app;
      const body = (await app.inject({ method: 'GET', url: '/v1/attributions' })).json();
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0]).toMatchObject({
        version: 'test-directory-1',
        entries: 2,
        attribution: 'test attribution',
      });
    });
  });
});

describe('error handling', () => {
  it('never leaks an internal message to the caller on a 500', async () => {
    const made = await makeApp((a) => {
      a.get('/boom', async () => {
        throw new Error('connection string postgres://user:hunter2@db/imei failed');
      });
    });
    app = made.app;

    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('postgres://');
    expect(res.json().error).toMatchObject({ code: 'internal_error' });
    expect(res.json().error.request_id).toBeTruthy();
  });

  it('passes a 4xx message through, since it is our own text', async () => {
    const made = await makeApp();
    app = made.app;
    const res = await app.inject({ method: 'POST', url: '/v1/imei/validate', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });
});

describe('openapi', () => {
  it('serves the generated document at the documented path', async () => {
    // Fetch it over HTTP, not via app.swagger(): the earlier version of this test called the
    // helper directly and passed while /openapi.json did not exist at all.
    const made = await makeApp();
    app = made.app;
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/imei/validate', '/v1/tac/{tac}', '/healthz', '/readyz']),
    );
  });

  it('publishes no real IMEI in the document', async () => {
    const made = await makeApp();
    app = made.app;
    // Examples are published output; a real 15-digit number pasted into one is a leak.
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).body).not.toMatch(/\b\d{15}\b/);
  });
});
