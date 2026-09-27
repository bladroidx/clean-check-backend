import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgRepositories } from '../src/db/pg.js';
import {
  RetentionPolicyError,
  assertRetentionPolicy,
  partitionUpperBound,
  runRetention,
} from '../src/db/retention.js';

/**
 * Real Postgres. Runs only when TEST_DATABASE_URL points at a database dbmate has migrated --
 * `npm run test:integration` starts one in Docker, migrates it and runs this file. Everything else
 * in the suite uses in-memory repos or a fake pool, and neither can tell you whether a partition
 * attach, a DETACH/DROP or a NOT EXISTS sweep actually does what its SQL says.
 */
const url = process.env['TEST_DATABASE_URL'];

describe('retention helpers', () => {
  it('bounds only names that are monthly partitions -- never DEFAULT', () => {
    expect(partitionUpperBound('checks', 'checks_p202603')?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(partitionUpperBound('checks', 'checks_p202612')?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(partitionUpperBound('checks', 'checks_default')).toBeUndefined();
    expect(partitionUpperBound('checks', 'provider_calls_p202603')).toBeUndefined();
    expect(partitionUpperBound('checks', 'checks_p202613')).toBeUndefined();
    expect(partitionUpperBound('checks', 'checks_p202603; DROP TABLE tenants')).toBeUndefined();
  });

  it('refuses a window short enough to be a typo', () => {
    expect(() => assertRetentionPolicy({ checksDays: 18, providerCallsDays: 400 })).toThrow(RetentionPolicyError);
    expect(() => assertRetentionPolicy({ checksDays: Number.NaN, providerCallsDays: 400 })).toThrow(RetentionPolicyError);
    expect(() => assertRetentionPolicy({ checksDays: 1800, providerCallsDays: 400 })).toThrow(RetentionPolicyError);
    expect(() => assertRetentionPolicy({ checksDays: 180, providerCallsDays: 400 })).not.toThrow();
  });
});

describe.skipIf(url === undefined)('Postgres (TEST_DATABASE_URL)', () => {
  let pool: pg.Pool;
  let repos: PgRepositories;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    repos = new PgRepositories(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE checks, check_sections, provider_calls, provider_orders, idempotency_records,
                      provider_balance_snapshots, provider_service_overrides, cache_entries, tenants CASCADE`);
    await pool.query(
      `INSERT INTO tenants (id, name, plan, status, imei_salt) VALUES ('t1','T','std','active', $1)`,
      ['a'.repeat(64)],
    );
    for (let month = 1; month <= 9; month += 1) {
      const m = `2026-${String(month).padStart(2, '0')}-01`;
      await pool.query(`SELECT imei_ensure_month_partition('checks'::regclass, 'created_at', $1::date)`, [m]);
      await pool.query(`SELECT imei_ensure_month_partition('provider_calls'::regclass, 'started_at', $1::date)`, [m]);
    }
  });

  const insertCheck = async (id: string, createdAt: string) => {
    await repos.checks.insert({
      id,
      tenantId: 't1',
      imeiHash: `h_${id}`,
      subjectHash: `s_${id}`,
      imeiMasked: '35•••••••••••78',
      tac: '35310411',
      requestedCapabilities: ['blacklist.gsma'],
      status: 'complete',
      idempotencyKey: undefined,
      creditsCharged: 0,
      verdict: 'amber',
      createdAt: new Date(createdAt),
      completedAt: new Date(createdAt),
      tier: 'deep',
      imeiEncrypted: Buffer.from('ciphertext'),
      imeiKeyVersion: 1,
    });
  };
  const insertSection = async (checkId: string, checkedAt: string) => {
    await pool.query(
      `INSERT INTO check_sections (check_id, capability, outcome, coverage, checked_at)
       VALUES ($1, 'blacklist.gsma', 'inconclusive', '{}', $2)`,
      [checkId, checkedAt],
    );
  };
  const insertCall = async (id: string, startedAt: string, costUsd = 0.1) => {
    await repos.providerCalls.start({
      id,
      checkId: undefined,
      tenantId: 't1',
      providerId: 'imei24',
      serviceId: '486',
      capability: 'blacklist.gsma',
      status: 'in_flight',
      providerCostUsd: costUsd,
      creditsCharged: 0,
      billable: true,
      latencyMs: undefined,
      errorCode: undefined,
      startedAt: new Date(startedAt),
      finishedAt: undefined,
    });
  };
  const count = async (sql: string): Promise<number> => Number((await pool.query<{ n: string }>(sql)).rows[0]?.n);

  it('drops whole expired months of checks -- encrypted IMEI included -- and sweeps what hung off them', async () => {
    await insertCheck('chk_jan', '2026-01-10T00:00:00Z');
    await insertCheck('chk_feb', '2026-02-27T23:59:00Z');
    await insertCheck('chk_mar', '2026-03-15T00:00:00Z');
    await insertCheck('chk_apr', '2026-04-10T00:00:00Z');
    await insertCheck('chk_sep', '2026-09-20T00:00:00Z');
    await insertSection('chk_jan', '2026-01-10T00:00:00Z');
    await insertSection('chk_sep', '2026-09-20T00:00:00Z');
    await pool.query(
      `INSERT INTO idempotency_records (tenant_id, key, request_digest, created_at) VALUES
         ('t1','old','d','2026-01-10'), ('t1','new','d','2026-09-20')`,
    );
    await pool.query(
      `INSERT INTO provider_orders (id, check_id, tenant_id, provider_id, service_id, capability, reference_id,
                                    status, expires_at, created_at) VALUES
         ('o_old','chk_jan','t1','imei24','486','blacklist.gsma','r1','answered','2026-01-11','2026-01-10'),
         ('o_old_pending','chk_jan','t1','imei24','486','blacklist.gsma','r2','pending','2026-01-11','2026-01-10'),
         ('o_new','chk_sep','t1','imei24','486','blacklist.gsma','r3','answered','2026-09-21','2026-09-20')`,
    );

    // 180 days before 2026-09-27 is 2026-03-31: January and February are wholly older and are
    // DROPped; March straddles the cutoff and is trimmed by DELETE, so nothing outlives 180 days.
    const summary = await runRetention(pool, { checksDays: 180, providerCallsDays: 400 }, new Date('2026-09-27T00:00:00Z'));

    expect(summary.partitionsDropped).toEqual(expect.arrayContaining(['checks_p202601', 'checks_p202602']));
    expect(summary.partitionsDropped).not.toContain('checks_p202603');
    expect(summary.partitionsDropped.some((p) => p.startsWith('provider_calls'))).toBe(false);
    expect((await pool.query('SELECT id FROM checks ORDER BY id')).rows.map((r) => r.id)).toEqual(['chk_apr', 'chk_sep']);
    expect(await count(`SELECT count(*) AS n FROM pg_class WHERE relname = 'checks_p202603'`)).toBe(1);
    expect(await repos.checks.encryptedImei('chk_jan')).toBeUndefined();
    expect(await count(`SELECT count(*) AS n FROM pg_class WHERE relname = 'checks_default'`)).toBe(1);

    expect((await pool.query('SELECT check_id FROM check_sections')).rows.map((r) => r.check_id)).toEqual(['chk_sep']);
    expect((await pool.query('SELECT key FROM idempotency_records')).rows.map((r) => r.key)).toEqual(['new']);
    // A pending order is the poller's to settle, never retention's.
    expect((await pool.query('SELECT id FROM provider_orders ORDER BY id')).rows.map((r) => r.id)).toEqual([
      'o_new',
      'o_old_pending',
    ]);
  });

  it('creates partitions ahead, and rescues rows that had already landed in DEFAULT', async () => {
    // A previous run may have created these; start from "they do not exist yet".
    for (const month of ['202612', '202701', '202702']) {
      await pool.query(`DROP TABLE IF EXISTS provider_calls_p${month}`);
    }
    // The worker was down past the months-ahead margin: a December row sits in DEFAULT.
    await insertCall('pc_dec', '2026-12-03T10:00:00Z');
    expect(await count('SELECT count(*) AS n FROM provider_calls_default')).toBe(1);

    const summary = await runRetention(pool, { checksDays: 180, providerCallsDays: 400 }, new Date('2026-12-15T00:00:00Z'));

    expect(summary.partitionsCreated).toEqual(
      expect.arrayContaining(['provider_calls_p202612', 'provider_calls_p202701', 'provider_calls_p202702']),
    );
    expect(await count('SELECT count(*) AS n FROM provider_calls_default')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM provider_calls_p202612')).toBe(1);
    // Idempotent: a second run creates nothing new.
    const again = await runRetention(pool, { checksDays: 180, providerCallsDays: 400 }, new Date('2026-12-15T00:00:00Z'));
    expect(again.partitionsCreated).toEqual([]);
  });

  it('refuses to run with a window short enough to be a typo', async () => {
    await insertCheck('chk_sep', '2026-09-20T00:00:00Z');
    await expect(runRetention(pool, { checksDays: 1, providerCallsDays: 400 }, new Date('2026-09-27T00:00:00Z'))).rejects.toThrow(
      RetentionPolicyError,
    );
    expect(await count('SELECT count(*) AS n FROM checks')).toBe(1);
  });

  it('sums recorded spend in a half-open window, with the final cost from finish()', async () => {
    await insertCall('a', '2026-09-27T00:00:00Z');
    await insertCall('b', '2026-09-27T00:30:00Z');
    await insertCall('c', '2026-09-27T01:00:00Z');
    await repos.providerCalls.finish('b', { status: 'failed', providerCostUsd: 0 });
    const from = new Date('2026-09-27T00:00:00Z');
    const to = new Date('2026-09-27T01:00:00Z');
    expect(await repos.providerCalls.costBetweenForProvider('imei24', from, to)).toBeCloseTo(0.1);
    expect(await repos.providerCalls.costBetweenForProvider('other', from, to)).toBe(0);
  });

  it('stores balance snapshots and returns the latest', async () => {
    await repos.balances.record({ providerId: 'imei24', balanceUsd: 100, takenAt: new Date('2026-09-27T00:00:00Z') });
    await repos.balances.record({ providerId: 'imei24', balanceUsd: 97.35, takenAt: new Date('2026-09-27T01:00:00Z') });
    expect(await repos.balances.latest('imei24')).toEqual({
      providerId: 'imei24',
      balanceUsd: 97.35,
      takenAt: new Date('2026-09-27T01:00:00Z'),
    });
    expect(await repos.balances.latest('nobody')).toBeUndefined();
  });

  it('keeps the first detection time when a disabled service is re-detected, and only clear() lifts it', async () => {
    const first = new Date('2026-09-27T00:00:00Z');
    await repos.serviceOverrides.disable({
      providerId: 'imei24', serviceId: '486', reason: 'price_increased', cataloguePriceUsd: 0.1, livePriceUsd: 0.5, detectedAt: first,
    });
    await repos.serviceOverrides.disable({
      providerId: 'imei24', serviceId: '486', reason: 'price_increased', cataloguePriceUsd: 0.1, livePriceUsd: 1, detectedAt: new Date('2026-09-28T00:00:00Z'),
    });
    expect(await repos.serviceOverrides.list()).toEqual([
      { providerId: 'imei24', serviceId: '486', reason: 'price_increased', cataloguePriceUsd: 0.1, livePriceUsd: 1, detectedAt: first },
    ]);
    expect(await repos.serviceOverrides.isDisabled('imei24', '486')).toBe(true);
    expect(await repos.serviceOverrides.clear('imei24', '486')).toBe(true);
    expect(await repos.serviceOverrides.clear('imei24', '486')).toBe(false);
    expect(await repos.serviceOverrides.isDisabled('imei24', '486')).toBe(false);
  });

  /** Runs the erasure SQL exactly as docs/privacy.md publishes it, so the doc cannot drift. */
  it('the documented DSAR erasure removes every row derived from the IMEI hash', async () => {
    const doc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'privacy.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### Erasure (DSAR)'));
    const sql = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
    expect(sql).toBeDefined();

    await insertCheck('chk_subject', '2026-09-20T00:00:00Z');
    await insertCheck('chk_other', '2026-09-20T00:00:00Z');
    await insertSection('chk_subject', '2026-09-20T00:00:00Z');
    await insertSection('chk_other', '2026-09-20T00:00:00Z');
    await pool.query(
      `INSERT INTO idempotency_records (tenant_id, key, request_digest, check_id) VALUES
         ('t1','k1','d','chk_subject'), ('t1','k2','d','chk_other')`,
    );
    await pool.query(
      `INSERT INTO provider_orders (id, check_id, tenant_id, provider_id, service_id, capability, reference_id,
                                    imei_hash, status, expires_at) VALUES
         ('o1','chk_subject','t1','imei24','486','blacklist.gsma','r1','h_chk_subject','answered', now()),
         ('o2','chk_other','t1','imei24','486','blacklist.gsma','r2','h_chk_other','answered', now())`,
    );
    await pool.query(
      `INSERT INTO cache_entries (cache_key, capability, field, payload, coverage, checked_at, expires_at) VALUES
         ('h_chk_subject:identity.model','identity.model','identity.model','{}','{}', now(), now() + interval '1 day'),
         ('h_chk_other:identity.model','identity.model','identity.model','{}','{}', now(), now() + interval '1 day')`,
    );

    const client = await pool.connect();
    try {
      // The doc's statements, one at a time, with $1 bound to the subject's hash.
      for (const statement of sql!.split(';').map((x) => x.trim()).filter((x) => x.length > 0)) {
        await client.query(statement, statement.includes('$1') ? ['h_chk_subject'] : []);
      }
    } finally {
      client.release();
    }

    const everything = async () =>
      (await pool.query(
        `SELECT (SELECT json_agg(id) FROM checks) AS c, (SELECT json_agg(check_id) FROM check_sections) AS s,
                (SELECT json_agg(check_id) FROM idempotency_records) AS i, (SELECT json_agg(id) FROM provider_orders) AS o,
                (SELECT json_agg(cache_key) FROM cache_entries) AS k`,
      )).rows[0];
    expect(await everything()).toEqual({
      c: ['chk_other'],
      s: ['chk_other'],
      i: ['chk_other'],
      o: ['o2'],
      k: ['h_chk_other:identity.model'],
    });
  });
});
