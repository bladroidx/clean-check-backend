import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { makeApp, SENTINEL } from './helpers.js';
import { makePaidApp } from './paid-helpers.js';

/**
 * Auth gating on the lookup routes, and the account-management surface that no longer exists.
 *
 * With a database configured this service has exactly one caller (the single seeded tenant), and
 * an open `/v1/tac/:tac` would be an open redistribution endpoint for a dataset we are only
 * licensed to attribute (ADR-0005). Without a database the free offline tier stays open, as
 * documented (CLAUDE.md, milestone M0) -- there is no key store to check a caller against.
 *
 * Account management (credits, the abuse ladder, outbound webhooks) was removed entirely: there
 * is no "on" state to switch, so the only thing left worth pinning here is that the routes it
 * added are genuinely gone, not just disabled.
 */

type Harness = Awaited<ReturnType<typeof makePaidApp>>;

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

async function harness(options: Parameters<typeof makePaidApp>[0] = {}): Promise<Harness> {
  const made = await makePaidApp(options);
  open.push(made.app);
  return made;
}

/**
 * The lookup routes are free of charge but no longer free of auth. With a database configured this
 * service has exactly one caller, and an open `/v1/tac/:tac` is an open redistribution endpoint for
 * a dataset we are only licensed to attribute (ADR-0005).
 */
const LOOKUP_ROUTES = [
  ['POST', '/v1/imei/validate'],
  ['GET', '/v1/tac/35847191'],
  ['GET', '/v1/attributions'],
] as const;

/**
 * The POST carries a body and the GETs do not, so the two shapes are built separately rather than
 * spread from an optional -- `exactOptionalPropertyTypes` rejects an explicitly-undefined payload.
 */
function callLookup(app: App, url: string, headers?: Record<string, string>) {
  return url === '/v1/imei/validate'
    ? app.inject({
        method: 'POST',
        url,
        payload: { imei: SENTINEL },
        ...(headers !== undefined ? { headers } : {}),
      })
    : app.inject({ method: 'GET', url, ...(headers !== undefined ? { headers } : {}) });
}

describe('lookup routes are gated when a database is configured', () => {
  it.each(LOOKUP_ROUTES)('%s %s is 401 without an API key', async (_method, url) => {
    const h = await harness();
    const response = await callLookup(h.app, url);

    expect(response.statusCode).toBe(401);
    // The 401 must be as uninformative as every other one, and must not echo the subject.
    expect(response.body).not.toContain(SENTINEL);
  });

  it.each(LOOKUP_ROUTES)('%s %s answers with a valid key', async (_method, url) => {
    const h = await harness();
    const response = await callLookup(h.app, url, h.auth());

    expect(response.statusCode).toBe(200);
  });

  it('gates a bad key exactly as it gates a missing one', async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: 'GET',
      url: '/v1/tac/35847191',
      headers: { authorization: 'Bearer ik_live_not_a_real_key' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('the free offline tier stays open', () => {
  // CLAUDE.md: a supported mode, not a degraded one. There is no key store to check a caller
  // against without a database, so gating here would just break the mode.
  it.each(LOOKUP_ROUTES)('%s %s needs no API key without a database', async (_method, url) => {
    const made = await makeApp();
    open.push(made.app);

    const response = await callLookup(made.app, url);

    expect(response.statusCode).toBe(200);
  });
});

describe('account management no longer exists', () => {
  it('GET /v1/balance is not registered', async () => {
    const h = await harness();
    const response = await h.app.inject({ method: 'GET', url: '/v1/balance', headers: h.auth() });
    expect(response.statusCode).toBe(404);
  });

  it('POST /v1/webhooks is not registered', async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: h.auth(),
      payload: { url: 'https://hooks.example.com/imei' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('is absent from the published schema entirely', async () => {
    // A client generating from OpenAPI must not be handed a route that does not exist.
    const h = await harness();
    const doc = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(Object.keys(doc.paths)).not.toContain('/v1/balance');
    expect(Object.keys(doc.paths)).not.toContain('/v1/webhooks');
  });

  it('/metrics is still registered -- it was never account management', async () => {
    const h = await harness();
    expect((await h.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });
});
