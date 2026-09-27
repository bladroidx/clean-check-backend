import type pg from 'pg';

/**
 * Retention: the only code that deletes operational data.
 *
 * `checks` carries the reversible IMEI (`imei_encrypted`, ADR-0007), so "retention is a partition
 * drop" is a privacy promise, not housekeeping -- and until this existed it was a promise nothing
 * kept. `checks` and `provider_calls` are dropped a whole month at a time; the tables that are not
 * partitioned are deleted by age.
 *
 * Deliberately NOT touched:
 * - `imei_reveals`: an append-only audit log (a trigger refuses DELETE). It holds a check id, an
 *   actor and a scrubbed reason -- no IMEI, no hash -- and an audit trail that expires with the
 *   data it audits is no audit trail.
 * - `tenants`, `api_keys`, `tac_*`: configuration, not personal data.
 */

/** Below this a typo in an env var ("18" for "180") would wipe live data. */
export const MIN_RETENTION_DAYS = 30;

/**
 * Above these a typo in the other direction ("1800") would keep the reversible IMEI for years,
 * silently. Raising one is a privacy-notice change first and a code change second.
 */
export const MAX_RETENTION_DAYS: Readonly<Record<keyof RetentionPolicy, number>> = {
  checksDays: 365,
  providerCallsDays: 3650,
};

export interface RetentionPolicy {
  /** `checks` (incl. the encrypted IMEI), `check_sections`, `provider_orders`, `idempotency_records`. */
  readonly checksDays: number;
  /** `provider_calls` and `provider_balance_snapshots` -- our own spend records (no IMEI; a call row
   *  carries a check id, which stops leading anywhere once the check itself is gone). */
  readonly providerCallsDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { checksDays: 180, providerCallsDays: 400 };

/** Monthly partitions kept ready ahead of now, so a new row never lands in DEFAULT. */
export const MONTHS_AHEAD = 2;

export interface RetentionSummary {
  readonly partitionsCreated: readonly string[];
  readonly partitionsDropped: readonly string[];
  readonly rowsDeleted: Readonly<Record<string, number>>;
}

export class RetentionPolicyError extends Error {}

export function assertRetentionPolicy(policy: RetentionPolicy): void {
  for (const name of Object.keys(MAX_RETENTION_DAYS) as Array<keyof RetentionPolicy>) {
    const days = policy[name];
    const max = MAX_RETENTION_DAYS[name];
    if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > max) {
      throw new RetentionPolicyError(
        `retention ${name} must be a whole number of days between ${MIN_RETENTION_DAYS} and ${max} (got ${String(days)})`,
      );
    }
  }
}

const PARTITIONED = [
  { parent: 'checks', key: 'created_at', days: (p: RetentionPolicy) => p.checksDays },
  { parent: 'provider_calls', key: 'started_at', days: (p: RetentionPolicy) => p.providerCallsDays },
] as const;

/** First instant of the UTC month `offset` months from `at`. */
export function monthStartUtc(at: Date, offset = 0): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1));
}

/**
 * The exclusive upper bound of a monthly partition, from its name (`checks_p202603` -> 2026-04-01),
 * or undefined for anything that is not one -- the DEFAULT partition above all. Only a name this
 * matches can ever be dropped.
 */
export function partitionUpperBound(parent: string, name: string): Date | undefined {
  const match = new RegExp(`^${parent}_p(\\d{4})(\\d{2})$`).exec(name);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return new Date(Date.UTC(year, month, 1));
}

/** Queryable by both a pool and a checked-out client. */
type Db = Pick<pg.PoolClient, 'query'>;

/**
 * One run at a time across every worker (session advisory lock on a dedicated connection): two
 * concurrent runs would race to DETACH the same partition and the loser would throw. A run that
 * finds the lock held returns an empty summary -- the other worker is doing the job.
 */
export async function runRetention(
  pool: pg.Pool,
  policy: RetentionPolicy,
  now: Date = new Date(),
): Promise<RetentionSummary> {
  assertRetentionPolicy(policy);
  const client = await pool.connect();
  let releaseErr: Error | undefined;
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('imei_retention')) AS ok`,
    );
    if (rows[0]?.ok !== true) return { partitionsCreated: [], partitionsDropped: [], rowsDeleted: {} };
    try {
      return await retain(client, policy, now);
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('imei_retention'))`).catch((error: unknown) => {
        // Never hand a connection still holding the lock back to the pool.
        releaseErr = error instanceof Error ? error : new Error(String(error));
      });
    }
  } finally {
    client.release(releaseErr);
  }
}

async function retain(db: Db, policy: RetentionPolicy, now: Date): Promise<RetentionSummary> {
  const partitionsCreated: string[] = [];
  const partitionsDropped: string[] = [];
  const rowsDeleted: Record<string, number> = {};

  for (const table of PARTITIONED) {
    // Ahead first: a missing future partition is what lets rows pile up in DEFAULT.
    for (let offset = 0; offset <= MONTHS_AHEAD; offset += 1) {
      const month = monthStartUtc(now, offset).toISOString().slice(0, 10);
      const { rows } = await db.query<{ created: string | null }>(
        'SELECT imei_ensure_month_partition($1::regclass, $2, $3::date) AS created',
        [table.parent, table.key, month],
      );
      const created = rows[0]?.created;
      if (created !== null && created !== undefined) partitionsCreated.push(created);
    }

    const cutoff = new Date(now.getTime() - table.days(policy) * 86_400_000);
    const { rows: children } = await db.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = $1::regclass`,
      [table.parent],
    );
    for (const { name } of children) {
      const upper = partitionUpperBound(table.parent, name);
      // Only a partition whose NEWEST possible row is past the cutoff goes.
      if (upper === undefined || upper > cutoff) continue;
      await dropPartition(db, table.parent, name);
      partitionsDropped.push(name);
    }

    // Whole months go by DROP above; this trims the one month that straddles the cutoff (plus any
    // rows that landed in DEFAULT), so the window is the published number of days -- not up to a
    // month longer. Partition pruning keeps it to that one partition.
    const { rowCount } = await db.query(`DELETE FROM ${table.parent} WHERE ${table.key} < $1`, [cutoff]);
    rowsDeleted[table.parent] = rowCount ?? 0;
  }

  const checksCutoff = new Date(now.getTime() - policy.checksDays * 86_400_000);
  const callsCutoff = new Date(now.getTime() - policy.providerCallsDays * 86_400_000);

  // Sections of a check that is gone. Bounded by checked_at as well, so a section written a moment
  // before its check row (or during this sweep) can never be taken for an orphan.
  rowsDeleted['check_sections'] = await deleted(
    db,
    `DELETE FROM check_sections s
      WHERE s.checked_at < $1
        AND NOT EXISTS (SELECT 1 FROM checks c WHERE c.id = s.check_id)`,
    [checksCutoff],
  );
  // A pending order is left for the poller to settle or abandon; it expires long before this.
  rowsDeleted['provider_orders'] = await deleted(
    db,
    `DELETE FROM provider_orders WHERE created_at < $1 AND status <> 'pending'`,
    [checksCutoff],
  );
  rowsDeleted['idempotency_records'] = await deleted(
    db,
    'DELETE FROM idempotency_records WHERE created_at < $1',
    [checksCutoff],
  );
  rowsDeleted['provider_balance_snapshots'] = await deleted(
    db,
    'DELETE FROM provider_balance_snapshots WHERE taken_at < $1',
    [callsCutoff],
  );
  rowsDeleted['cache_entries'] = await deleted(db, 'DELETE FROM cache_entries WHERE expires_at <= $1', [now]);

  return { partitionsCreated, partitionsDropped, rowsDeleted };
}

async function deleted(db: Db, sql: string, params: unknown[]): Promise<number> {
  const { rowCount } = await db.query(sql, params);
  return rowCount ?? 0;
}

/**
 * DETACH then DROP in one transaction, so a failure leaves the partition attached, not orphaned.
 *
 * DETACH needs ACCESS EXCLUSIVE on the parent. Queued behind a long reader (a pg_dump backup) it
 * would hold every later API query on `checks` / `provider_calls` behind it, so it gives up after
 * 5 s instead: the run fails loudly and tomorrow's retries.
 */
async function dropPartition(client: Db, parent: string, name: string): Promise<void> {
  // `name` has matched `^<parent>_p\d{6}$` in partitionUpperBound, so it is safe to interpolate.
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`ALTER TABLE ${parent} DETACH PARTITION ${name}`);
    await client.query(`DROP TABLE ${name}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
