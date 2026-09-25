import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import type { CheckReport } from '@imei-check/contract';
import type { MemoryRepositories } from '@imei-check/core';
import { BUILTIN_LEXICONS, DhruLegacyProvider, loadCatalogueFile } from '@imei-check/providers';
import { SENTINEL } from './helpers.js';
import { idempotencyKey, makePaidApp } from './paid-helpers.js';

/**
 * Final review F1: the REAL `DhruLegacyProvider`, end to end -- place, poll, settle -- with only the
 * network mocked.
 *
 * Every other deep-check test uses a fake provider that returns `pending` because the test said
 * so. That is exactly how the standard DHRU placement acknowledgement (`"Order received"` plus a
 * REFERENCEID, no STATUS) went unnoticed: the real adapter read it as an empty answer, the order
 * reference was discarded, and the next check bought the same order again.
 */

const BASE = 'https://imei24.invalid';
const ROOT = join(import.meta.dirname, '..', '..', '..', 'packages', 'providers');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'imei24');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

describe('imei24 via the real DHRU legacy adapter', () => {
  it('a placement acknowledgement is polled on its REFERENCEID and settles the section', async () => {
    const forms: URLSearchParams[] = [];
    const pool = agent.get(BASE);
    const action = (name: string) => (body: string) => new URLSearchParams(body).get('action') === name;
    // Recorded in the reply, not the matcher: undici may run a body matcher more than once.
    const reply = (name: string) => (opts: { body?: unknown }) => {
      forms.push(new URLSearchParams(String(opts.body)));
      return fixture(name);
    };
    pool
      .intercept({ path: '/api/index.php', method: 'POST', body: action('placeimeiorder') })
      .reply(200, reply('placement-order-received.json'));
    pool
      .intercept({ path: '/api/index.php', method: 'POST', body: action('getimeiorder') })
      .reply(200, reply('blacklist-blacklisted.json'));

    const provider = new DhruLegacyProvider({
      providerId: 'imei24',
      baseUrl: BASE,
      username: 'u',
      apiAccessKey: 'k',
      services: loadCatalogueFile(join(ROOT, 'catalogue', 'imei24.yaml')),
      lexicons: BUILTIN_LEXICONS,
    });
    const h = await makePaidApp({ providers: [provider], deepWaitMs: 3_000, pollIntervalMs: 10 });

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/deep_checks',
      headers: { ...h.auth(), 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json<CheckReport>();

    // Placed once, then polled by the id the placement returned -- not re-bought, not dropped.
    expect(forms.map((f) => f.get('action'))).toEqual(['placeimeiorder', 'getimeiorder']);
    expect(forms[1]?.get('id')).toBe('71970');
    expect((h.repos as MemoryRepositories).providerCalls.rows.size).toBe(1);

    // The poll's answer settled the section: "Blacklisted" is a known-bad value.
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'fail' });
    expect(report.status).toBe('complete');
    expect(report.summary.verdict).toBe('red');

    const orders = await h.repos.orders.byReference(
      [...(h.repos as MemoryRepositories).providerCalls.rows.keys()][0] ?? '',
    );
    expect(orders).toMatchObject({ orderReference: '71970', status: 'answered' });
    expect(res.body).not.toContain(SENTINEL);
  });
});
