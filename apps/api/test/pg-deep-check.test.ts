import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import type { CheckReport } from '@imei-check/contract';
import { PgRepositories } from '@imei-check/core';
import { BUILTIN_LEXICONS, DhruLegacyProvider, loadCatalogueFile } from '@imei-check/providers';
import { SENTINEL } from './helpers.js';
import { TEST_CIPHER, idempotencyKey, makePaidApp, type PaidHarness } from './paid-helpers.js';

/**
 * The deep (paid) path against REAL Postgres, over a REAL port, through the REAL imei24 adapter --
 * only the supplier's network is mocked.
 *
 * Until this existed the paid path had never touched Postgres: every deep-check test ran on
 * in-memory repositories via `inject()`, and both of those have already hidden a production bug
 * each (the budget that aborted on arrival over a real socket, 623ca3f). Runs only when
 * TEST_DATABASE_URL points at a migrated database: `npm run test:integration`.
 */
const url = process.env['TEST_DATABASE_URL'];

const BASE = 'https://imei24.invalid';
const ROOT = join(import.meta.dirname, '..', '..', '..', 'packages', 'providers');
const fixture = (name: string) => readFileSync(join(ROOT, 'test', 'fixtures', 'imei24', name), 'utf8');
const imei24 = () =>
  new DhruLegacyProvider({
    providerId: 'imei24',
    baseUrl: BASE,
    username: 'u',
    apiAccessKey: 'k',
    services: loadCatalogueFile(join(ROOT, 'catalogue', 'imei24.yaml')),
    lexicons: BUILTIN_LEXICONS,
  });

/** A fresh Luhn-valid iPhone 13 IMEI, built at runtime so none is ever committed. */
function freshImei(): string {
  const body = `35310411${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

describe.skipIf(url === undefined)('deep checks on Postgres (TEST_DATABASE_URL)', () => {
  let pool: pg.Pool;
  let agent: MockAgent;
  let original: Dispatcher;
  let harness: PaidHarness | undefined;
  const actions: string[] = [];

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 10 });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE checks, check_sections, provider_calls, provider_orders, idempotency_records,
                      provider_service_overrides, cache_entries, tenants CASCADE`);
    original = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect(/127\.0\.0\.1/);
    setGlobalDispatcher(agent);
    actions.length = 0;
  });

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
    setGlobalDispatcher(original);
    await agent.close();
  });

  const supplier = (routes: Record<string, string>) => {
    for (const [action, file] of Object.entries(routes)) {
      agent
        .get(BASE)
        .intercept({
          path: '/api/index.php',
          method: 'POST',
          body: (body: string) => new URLSearchParams(body).get('action') === action,
        })
        .reply(200, () => {
          actions.push(action);
          return fixture(file);
        })
        .persist();
    }
  };

  const start = async (options: { dailySpendUsd?: number } = {}) => {
    // The app's own pool: the repos it writes through are exactly production's.
    harness = await makePaidApp({
      providers: [imei24()],
      repos: new PgRepositories(new pg.Pool({ connectionString: url, max: 10 })),
      deepWaitMs: 4_000,
      pollIntervalMs: 20,
      ...options,
    });
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    return (harness.app.server.address() as AddressInfo).port;
  };

  const deepCheck = async (port: number, imei: string): Promise<CheckReport> => {
    if (harness === undefined) throw new Error('start() first');
    const res = await fetch(`http://127.0.0.1:${port}/v1/deep_checks`, {
      method: 'POST',
      headers: { ...harness.auth(), 'idempotency-key': idempotencyKey(), 'content-type': 'application/json' },
      body: JSON.stringify({ imei }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as CheckReport;
  };

  it('places, polls and settles an order, and stores the IMEI only encrypted', async () => {
    supplier({ placeimeiorder: 'placement-order-received.json', getimeiorder: 'blacklist-blacklisted.json' });
    const port = await start();

    const report = await deepCheck(port, SENTINEL);
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'fail' });
    expect(report.summary.verdict).toBe('red');
    expect(actions).toEqual(['placeimeiorder', 'getimeiorder']);

    // One provider_calls row, priced at the catalogue cost of the one service bought.
    const calls = await pool.query<{ service_id: string; provider_cost_usd: string; status: string }>(
      'SELECT service_id, provider_cost_usd, status FROM provider_calls',
    );
    expect(calls.rows).toHaveLength(1);
    expect(Number(calls.rows[0]?.provider_cost_usd)).toBeGreaterThan(0);

    // The order and section persisted; the check row lives in a monthly partition, not DEFAULT.
    const order = await pool.query<{ status: string; order_reference: string }>('SELECT status, order_reference FROM provider_orders');
    expect(order.rows[0]).toMatchObject({ status: 'answered', order_reference: '71970' });
    expect(Number((await pool.query('SELECT count(*) AS n FROM checks_default')).rows[0].n)).toBe(0);

    // ADR-0007: decryptable with the keyring, and the raw digits appear in no column of any table.
    const encrypted = await harness!.repos.checks.encryptedImei(report.check_id);
    expect(encrypted).toBeDefined();
    expect(TEST_CIPHER.decrypt(encrypted!.imeiEncrypted, encrypted!.imeiKeyVersion, report.check_id)).toBe(SENTINEL);
    // Every table in the schema, not a hand-kept list: a column added next month is covered too.
    const { rows: tables } = await pool.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(tables.length).toBeGreaterThan(10);
    for (const { t } of tables) {
      const dump = (await pool.query(`SELECT row_to_json(x)::text AS j FROM "${t}" x`)).rows.map((r) => r.j).join('\n');
      expect(dump, t).not.toContain(SENTINEL);
    }
  });

  it('the daily spend cap sums real provider_calls rows and refuses the next purchase', async () => {
    supplier({ placeimeiorder: 'blacklist-blacklisted.json' });
    // Service 690 (Apple, $0.12) is bought first; a $0.15 cap admits exactly one.
    const port = await start({ dailySpendUsd: 0.15 });

    const first = await deepCheck(port, freshImei());
    expect(first.sections['blacklist.gsma']).toMatchObject({ outcome: 'fail' });
    const second = await deepCheck(port, freshImei());
    expect(second.sections['blacklist.gsma']).toMatchObject({ outcome: 'unavailable', reason: 'spend_cap_reached' });
    expect(actions).toEqual(['placeimeiorder']);

    // The refused attempts are recorded at zero cost: the cap must not count money never spent.
    const total = await pool.query<{ n: string }>('SELECT COALESCE(SUM(provider_cost_usd),0) AS n FROM provider_calls');
    expect(Number(total.rows[0]?.n)).toBeCloseTo(0.12);
  });

  it('a service the drift job disabled is not bought; the sibling service is', async () => {
    supplier({ placeimeiorder: 'blacklist-blacklisted.json' });
    await pool.query(
      `INSERT INTO provider_service_overrides (provider_id, service_id, reason, catalogue_price_usd, live_price_usd)
       VALUES ('imei24', '690', 'price_increased', 0.12, 1.20)`,
    );
    const port = await start();

    const report = await deepCheck(port, freshImei());
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'fail' });
    const bought = await pool.query<{ service_id: string; provider_cost_usd: string }>(
      'SELECT service_id, provider_cost_usd FROM provider_calls ORDER BY started_at',
    );
    expect(bought.rows.map((r) => [r.service_id, Number(r.provider_cost_usd)])).toEqual([
      ['690', 0],
      ['486', 0.1],
    ]);
  });

  it('with every covering service disabled the section is unavailable -- never a pass', async () => {
    supplier({ placeimeiorder: 'blacklist-blacklisted.json' });
    await pool.query(
      `INSERT INTO provider_service_overrides (provider_id, service_id, reason, catalogue_price_usd, live_price_usd)
       VALUES ('imei24', '690', 'price_increased', 0.12, 1.20), ('imei24', '486', 'missing_from_supplier_list', 0.10, NULL)`,
    );
    const port = await start();

    const report = await deepCheck(port, freshImei());
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'unavailable', reason: 'provider_not_configured' });
    expect(actions).toEqual([]);
  });
});
