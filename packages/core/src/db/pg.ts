import pg from 'pg';
import type {
  ApiKeyRecord,
  ApiKeyRepo,
  CacheRepo,
  CacheRow,
  CheckRecord,
  CheckRepo,
  CheckSummary,
  IdempotencyRecord,
  IdempotencyRepo,
  ImeiRevealRecord,
  ImeiRevealRepo,
  OrderRepo,
  OrderRow,
  ProviderCallRepo,
  ProviderCallRow,
  ProviderLock,
  Repositories,
  StoredSection,
  Tenant,
  TenantRepo,
} from './types.js';
import type { Capability, Coverage, Outcome, SectionResult, Verdict } from '@imei-check/contract';
import { assertStrongTenantSalt } from './tenant-salt.js';

const { Pool } = pg;

/**
 * Postgres repositories.
 *
 * The only genuinely subtle thing in this file is `reserve`, and it is subtle on purpose: a credit
 * reservation must be atomic against a concurrent check, idempotent under retry, and must leave
 * the ledger and the cached balance in agreement. It is one statement chain inside one transaction
 * with `SELECT ... FOR UPDATE`, and the idempotency guarantee comes from a UNIQUE constraint
 * rather than from checking first -- because checking first is exactly what loses the race.
 */

export interface PoolOptions {
  /** Where a lost-connection event goes. Without one it is swallowed; with one it is operable. */
  readonly onError?: (error: Error) => void;
}

export function createPool(databaseUrl: string, options: PoolOptions = {}): pg.Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    // A paid check that queues behind an exhausted pool should fail fast and be retried, not hang
    // holding a supplier call open behind it.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  /**
   * Without this handler the process DIES on a dropped connection.
   *
   * `pg.Pool` emits `'error'` for a client that fails while idle -- a Postgres restart, a failover,
   * a network blip, a connection reaped by a proxy. In Node an unhandled `'error'` event on an
   * EventEmitter is thrown, so a five-second failover became a crashed API and a restart loop
   * across every replica at once. This was found by tearing the database out from under a running
   * server during a smoke test, which is exactly what a failover looks like.
   *
   * The right behaviour is to log it and carry on: the pool discards the bad client and the next
   * query opens a fresh one. An in-flight query still fails, and it fails as a 500 on that one
   * request rather than as an outage.
   */
  pool.on('error', (error: Error) => {
    options.onError?.(error);
  });

  return pool;
}

/**
 * The migration this build of the code requires.
 *
 * Readiness checks this against what dbmate has actually applied, which is what catches the deploy
 * that rolled the image forward and the schema not at all -- the failure mode where the service
 * reports ready and then 500s every paid check.
 *
 * It is a constant rather than a read of `db/migrations/` because the deploy artefact does not
 * ship that directory: the code, not the filesystem, is what knows which schema it needs. Keeping
 * it honest is a test's job rather than a comment's -- `schema-version.test.ts` fails the moment a
 * migration is added without bumping it.
 */
export const REQUIRED_SCHEMA_VERSION = '20260925000002';

export interface DatabaseReadiness {
  readonly reachable: boolean;
  readonly migrationsCurrent: boolean;
  readonly appliedVersion: string | undefined;
}

/**
 * Readiness probe for the paid path.
 *
 * Bounded by its own timeout rather than the pool's: an unresponsive database must make `/readyz`
 * answer 503 quickly, not hang until the orchestrator's probe deadline and read as a timeout of
 * the whole process.
 */
export async function checkDatabase(pool: pg.Pool, timeoutMs = 2_000): Promise<DatabaseReadiness> {
  let timer: NodeJS.Timeout | undefined;
  try {
    /**
     * Presence of the exact required version, NOT `max(version) >= required`.
     *
     * The two diverge the first time branches merge with interleaved timestamps: a later migration
     * lands, the one this build needs does not, `max()` clears the bar, readiness says ok, and the
     * missing table 500s every paid check -- precisely the failure this probe exists to catch. It
     * also reports `behind` after a rollback, which the comparison form does not.
     *
     * `latest` is carried purely so an operator reading `/readyz` can see where the schema is.
     */
    const query = pool.query<{ latest: string | null; required_applied: boolean }>(
      `SELECT (SELECT max(version) FROM schema_migrations) AS latest,
              EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1) AS required_applied`,
      [REQUIRED_SCHEMA_VERSION],
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('database readiness probe timed out')), timeoutMs);
    });
    const { rows } = await Promise.race([query, timeout]);
    return {
      reachable: true,
      migrationsCurrent: rows[0]?.required_applied === true,
      appliedVersion: rows[0]?.latest ?? undefined,
    };
  } catch (error) {
    // A missing schema_migrations means dbmate has never run against this database. That is
    // reachable-but-unmigrated, not unreachable, and the two want different operator responses.
    if (isUndefinedTable(error)) {
      return { reachable: true, migrationsCurrent: false, appliedVersion: undefined };
    }
    return { reachable: false, migrationsCurrent: false, appliedVersion: undefined };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isUndefinedTable(error: unknown): boolean {
  return (
    error !== null && typeof error === 'object' && (error as { code?: unknown }).code === '42P01'
  );
}

export class PgRepositories implements Repositories {
  readonly tenants: TenantRepo;
  readonly apiKeys: ApiKeyRepo;
  readonly checks: CheckRepo;
  readonly providerCalls: ProviderCallRepo;
  readonly cache: CacheRepo;
  readonly orders: OrderRepo;
  readonly idempotency: IdempotencyRepo;
  readonly locks: ProviderLock;
  readonly reveals: ImeiRevealRepo;

  constructor(private readonly pool: pg.Pool) {
    this.tenants = new PgTenantRepo(pool);
    this.apiKeys = new PgApiKeyRepo(pool);
    this.checks = new PgCheckRepo(pool);
    this.providerCalls = new PgProviderCallRepo(pool);
    this.cache = new PgCacheRepo(pool);
    this.orders = new PgOrderRepo(pool);
    this.idempotency = new PgIdempotencyRepo(pool);
    this.locks = new PgProviderLock(pool);
    this.reveals = new PgImeiRevealRepo(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgTenantRepo implements TenantRepo {
  constructor(private readonly pool: pg.Pool) {}
  async byId(id: string): Promise<Tenant | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      plan: string;
      status: string;
      imei_salt: string;
    }>('SELECT id, name, plan, status, imei_salt FROM tenants WHERE id = $1', [id]);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      name: row.name,
      plan: row.plan,
      status: row.status === 'active' ? 'active' : 'suspended',
      imeiSalt: row.imei_salt,
    };
  }
  async create(tenant: Tenant): Promise<void> {
    assertStrongTenantSalt(tenant.imeiSalt);
    await this.pool.query(
      `INSERT INTO tenants (id, name, plan, status, imei_salt) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [tenant.id, tenant.name, tenant.plan, tenant.status, tenant.imeiSalt],
    );
  }
  async listAll(): Promise<readonly Tenant[]> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      plan: string;
      status: string;
      imei_salt: string;
    }>('SELECT id, name, plan, status, imei_salt FROM tenants ORDER BY id');
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      plan: row.plan,
      status: row.status === 'active' ? 'active' : 'suspended',
      imeiSalt: row.imei_salt,
    }));
  }
}

class PgApiKeyRepo implements ApiKeyRepo {
  constructor(private readonly pool: pg.Pool) {}
  async byHash(sha256: string): Promise<ApiKeyRecord | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      tenant_id: string;
      prefix: string;
      scopes: string[];
      revoked_at: Date | null;
      expires_at: Date | null;
    }>(
      'SELECT id, tenant_id, prefix, scopes, revoked_at, expires_at FROM api_keys WHERE key_sha256 = $1',
      [sha256],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      prefix: row.prefix,
      scopes: row.scopes,
      revokedAt: row.revoked_at ?? undefined,
      expiresAt: row.expires_at ?? undefined,
    };
  }
  async touch(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [id, at]);
  }
  async insert(record: ApiKeyRecord & { keySha256: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_keys (id, tenant_id, prefix, key_sha256, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [record.id, record.tenantId, record.prefix, record.keySha256, record.scopes, record.expiresAt ?? null],
    );
  }
}

class PgCheckRepo implements CheckRepo {
  constructor(private readonly pool: pg.Pool) {}

  async insert(record: CheckRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO checks
         (id, tenant_id, imei_hash, subject_hash, imei_masked, tac, requested_capabilities,
          status, idempotency_key, credits_charged, verdict, created_at, completed_at,
          tier, imei_encrypted, imei_key_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        record.id,
        record.tenantId,
        record.imeiHash,
        record.subjectHash,
        record.imeiMasked,
        record.tac ?? null,
        record.requestedCapabilities,
        record.status,
        record.idempotencyKey ?? null,
        record.creditsCharged,
        record.verdict ?? null,
        record.createdAt,
        record.completedAt ?? null,
        record.tier,
        record.imeiEncrypted ?? null,
        record.imeiKeyVersion ?? null,
      ],
    );
  }

  async update(id: string, patch: Partial<CheckRecord>): Promise<void> {
    await this.pool.query(
      `UPDATE checks SET
         status          = COALESCE($2, status),
         verdict         = COALESCE($3, verdict),
         credits_charged = COALESCE($4, credits_charged),
         completed_at    = COALESCE($5, completed_at)
       WHERE id = $1`,
      [id, patch.status ?? null, patch.verdict ?? null, patch.creditsCharged ?? null, patch.completedAt ?? null],
    );
  }

  async byId(tenantId: string, id: string, tier?: 'free' | 'deep'): Promise<CheckSummary | undefined> {
    // Ciphertext is never selected here -- `encryptedImei` is the only read path (ADR-0007).
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, tenant_id, imei_hash, subject_hash, imei_masked, tac, requested_capabilities,
              status, idempotency_key, credits_charged, verdict, created_at, completed_at, tier
       FROM checks WHERE tenant_id = $1 AND id = $2 AND ($3::text IS NULL OR tier = $3)`,
      [tenantId, id, tier ?? null],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: String(row['id']),
      tenantId: String(row['tenant_id']),
      imeiHash: String(row['imei_hash']),
      subjectHash: String(row['subject_hash'] ?? ''),
      imeiMasked: String(row['imei_masked'] ?? ''),
      tac: (row['tac'] as string | null) ?? undefined,
      requestedCapabilities: (row['requested_capabilities'] as Capability[]) ?? [],
      status: row['status'] as CheckRecord['status'],
      idempotencyKey: (row['idempotency_key'] as string | null) ?? undefined,
      creditsCharged: Number(row['credits_charged'] ?? 0),
      verdict: (row['verdict'] as Verdict | null) ?? undefined,
      createdAt: row['created_at'] as Date,
      completedAt: (row['completed_at'] as Date | null) ?? undefined,
      tier: row['tier'] as CheckRecord['tier'],
    };
  }

  async encryptedImei(id: string): Promise<{ imeiEncrypted: Buffer; imeiKeyVersion: number } | undefined> {
    const { rows } = await this.pool.query<{ imei_encrypted: Buffer | null; imei_key_version: number | null }>(
      'SELECT imei_encrypted, imei_key_version FROM checks WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row === undefined || row.imei_encrypted === null || row.imei_key_version === null) return undefined;
    return { imeiEncrypted: row.imei_encrypted, imeiKeyVersion: row.imei_key_version };
  }

  async putSection(section: StoredSection): Promise<void> {
    const s = section.section;
    await this.pool.query(
      `INSERT INTO check_sections
         (check_id, capability, outcome, reason, remedy, finding_key, severity, evidence, coverage,
          checked_at, cached)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (check_id, capability) DO UPDATE SET
         outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, remedy = EXCLUDED.remedy,
         finding_key = EXCLUDED.finding_key, severity = EXCLUDED.severity,
         evidence = EXCLUDED.evidence, coverage = EXCLUDED.coverage,
         checked_at = EXCLUDED.checked_at, cached = EXCLUDED.cached`,
      [
        section.checkId,
        section.capability,
        section.outcome,
        s.reason ?? null,
        s.remedy ?? null,
        s.finding?.key ?? null,
        s.finding?.severity ?? null,
        JSON.stringify(s.evidence),
        JSON.stringify(s.coverage),
        s.checked_at,
        s.freshness.cached,
      ],
    );
  }

  async sections(checkId: string): Promise<readonly StoredSection[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT check_id, capability, outcome, reason, remedy, finding_key, severity, evidence,
              coverage, checked_at, cached
       FROM check_sections WHERE check_id = $1`,
      [checkId],
    );
    return rows.map((row) => {
      const capability = row['capability'] as Capability;
      const outcome = row['outcome'] as Outcome;
      const section = {
        capability,
        outcome,
        checked_at: (row['checked_at'] as Date).toISOString(),
        coverage: row['coverage'] as Coverage,
        evidence: (row['evidence'] as SectionResult['evidence']) ?? [],
        ...(row['reason'] !== null ? { reason: row['reason'] as SectionResult['reason'] } : {}),
        ...(row['remedy'] !== null ? { remedy: row['remedy'] as SectionResult['remedy'] } : {}),
        ...(row['finding_key'] !== null
          ? {
              finding: {
                key: String(row['finding_key']),
                severity: row['severity'] as 'critical' | 'high' | 'medium' | 'low',
                summary: '',
              },
            }
          : {}),
        freshness: { cached: row['cached'] === true, age_seconds: 0, ttl_seconds: 0 },
      } satisfies SectionResult;
      return { checkId, capability, outcome, section };
    });
  }
}

class PgProviderCallRepo implements ProviderCallRepo {
  constructor(private readonly pool: pg.Pool) {}
  async start(row: ProviderCallRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_calls
         (id, check_id, tenant_id, provider_id, service_id, capability, status, provider_cost_usd,
          credits_charged, billable, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        row.id,
        row.checkId ?? null,
        row.tenantId,
        row.providerId,
        row.serviceId,
        row.capability,
        row.status,
        row.providerCostUsd,
        row.creditsCharged,
        row.billable,
        row.startedAt,
      ],
    );
  }
  async finish(id: string, patch: Partial<ProviderCallRow>): Promise<void> {
    // provider_cost_usd must be updated here too: the router now decides the FINAL cost of an
    // attempt (0 for anything never sent -- dedupe hits, spend-cap refusals, lock-busy
    // rate_limited, a failing beforeSend), and onCallFinish forwards that as `patch.providerCostUsd`.
    // Without this the column keeps the catalogue price onCallStart wrote, and the daily spend cap
    // (costSinceForProvider, below) overcounts every one of those cases. COALESCE, not a bare
    // assignment, so a `finish` call that omits the field (there is none today, but the interface
    // allows it) still leaves the started cost alone rather than nulling it out.
    await this.pool.query(
      `UPDATE provider_calls SET
         status = COALESCE($2, status), latency_ms = COALESCE($3, latency_ms),
         billable = COALESCE($4, billable), error_code = COALESCE($5, error_code),
         finished_at = COALESCE($6, finished_at), provider_cost_usd = COALESCE($7, provider_cost_usd)
       WHERE id = $1`,
      [
        id,
        patch.status ?? null,
        patch.latencyMs ?? null,
        patch.billable ?? null,
        patch.errorCode ?? null,
        patch.finishedAt ?? null,
        patch.providerCostUsd ?? null,
      ],
    );
  }
  async costSince(tenantId: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(provider_cost_usd),0) AS total FROM provider_calls
       WHERE tenant_id = $1 AND started_at >= $2`,
      [tenantId, since],
    );
    return Number(rows[0]?.total ?? 0);
  }
  async costSinceForProvider(providerId: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(provider_cost_usd),0) AS total FROM provider_calls
       WHERE provider_id = $1 AND started_at >= $2`,
      [providerId, since],
    );
    return Number(rows[0]?.total ?? 0);
  }
}

/**
 * Session-level `pg_try_advisory_lock`, taken and released on the SAME pooled client.
 *
 * A dedicated `pool.connect()` rather than `pool.query()` is the whole point: the advisory lock is
 * tied to the Postgres session (backend connection) that took it, not to the logical "transaction"
 * -- `pool.query()` may hand consecutive statements to different pooled connections, which would
 * silently release-on-acquire or unlock-the-wrong-session. Polling at 100ms rather than tighter
 * keeps this cheap enough to run from both the API and the worker without becoming its own load.
 */
class PgProviderLock implements ProviderLock {
  constructor(private readonly pool: pg.Pool) {}

  async withLock<T>(
    name: string,
    waitMs: number,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const client = await this.pool.connect();
    const deadline = Date.now() + waitMs;
    // If `pg_advisory_unlock` itself throws, the session-level lock may still be held on this
    // connection, and the pool must never hand that connection to another caller believing it is
    // clean. `releaseErr` is passed to `client.release(err)` so the pool destroys the connection
    // instead of returning it to the pool -- Postgres then frees the lock when the session ends.
    let releaseErr: unknown;
    try {
      for (;;) {
        const { rows } = await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
          [name],
        );
        if (rows[0]?.ok === true) break;
        if (Date.now() >= deadline) return { acquired: false };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      let result: { acquired: true; value: T };
      try {
        result = { acquired: true, value: await fn() };
      } catch (fnError) {
        // `fn` failed first. Still try to unlock, but a failure to unlock must not replace or
        // mask the error the caller actually needs to see.
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
        } catch (unlockError) {
          releaseErr = unlockError;
        }
        throw fnError;
      }
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
      } catch (unlockError) {
        releaseErr = unlockError;
      }
      return result;
    } finally {
      client.release(releaseErr as Error | undefined);
    }
  }
}

class PgCacheRepo implements CacheRepo {
  constructor(private readonly pool: pg.Pool) {}
  async get(cacheKey: string): Promise<CacheRow | undefined> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT cache_key, capability, field, payload, coverage, checked_at, expires_at, provider_id
       FROM cache_entries WHERE cache_key = $1`,
      [cacheKey],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const payload = row['payload'] as { value: string; rawLabel?: string };
    return {
      cacheKey: String(row['cache_key']),
      capability: row['capability'] as Capability,
      field: String(row['field']),
      value: payload.value,
      rawLabel: payload.rawLabel,
      coverage: row['coverage'] as Coverage,
      providerId: (row['provider_id'] as string | null) ?? undefined,
      checkedAt: row['checked_at'] as Date,
      expiresAt: row['expires_at'] as Date,
    };
  }
  async put(row: CacheRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO cache_entries
         (cache_key, capability, field, payload, coverage, checked_at, expires_at, provider_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (cache_key) DO UPDATE SET
         payload = EXCLUDED.payload, coverage = EXCLUDED.coverage,
         checked_at = EXCLUDED.checked_at, expires_at = EXCLUDED.expires_at,
         provider_id = EXCLUDED.provider_id`,
      [
        row.cacheKey,
        row.capability,
        row.field,
        JSON.stringify({ value: row.value, ...(row.rawLabel !== undefined ? { rawLabel: row.rawLabel } : {}) }),
        JSON.stringify(row.coverage),
        row.checkedAt,
        row.expiresAt,
        row.providerId ?? null,
      ],
    );
  }
  async purgeExpired(now: Date): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM cache_entries WHERE expires_at <= $1', [now]);
    return rowCount ?? 0;
  }
}

class PgOrderRepo implements OrderRepo {
  constructor(private readonly pool: pg.Pool) {}
  async insert(row: OrderRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_orders
         (id, check_id, tenant_id, provider_id, service_id, capability, reference_id,
          order_reference, imei_hash, status, attempts, next_poll_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        row.id, row.checkId, row.tenantId, row.providerId, row.serviceId, row.capability,
        row.referenceId, row.orderReference ?? null, row.imeiHash, row.status, row.attempts,
        row.nextPollAt ?? null, row.expiresAt, row.createdAt,
      ],
    );
  }
  async byReference(referenceId: string): Promise<OrderRow | undefined> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM provider_orders WHERE reference_id = $1',
      [referenceId],
    );
    return rows[0] === undefined ? undefined : toOrder(rows[0]);
  }
  async duePolls(now: Date, limit: number): Promise<readonly OrderRow[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM provider_orders
       WHERE status = 'pending' AND next_poll_at IS NOT NULL AND next_poll_at <= $1
       ORDER BY next_poll_at LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toOrder);
  }
  async update(id: string, patch: Partial<OrderRow>): Promise<void> {
    await this.pool.query(
      `UPDATE provider_orders SET
         status = COALESCE($2, status), attempts = COALESCE($3, attempts),
         next_poll_at = COALESCE($4, next_poll_at), order_reference = COALESCE($5, order_reference),
         settled_at = COALESCE($6, settled_at)
       WHERE id = $1`,
      [id, patch.status ?? null, patch.attempts ?? null, patch.nextPollAt ?? null, patch.orderReference ?? null, patch.settledAt ?? null],
    );
  }
  async openForCheck(checkId: string): Promise<readonly OrderRow[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM provider_orders WHERE check_id = $1 AND status = 'pending'`,
      [checkId],
    );
    return rows.map(toOrder);
  }
  async openForImei(imeiHash: string, serviceId: string, now: Date): Promise<OrderRow | undefined> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM provider_orders WHERE imei_hash = $1 AND service_id = $2 AND status = 'pending'
         AND expires_at > $3
       ORDER BY created_at DESC LIMIT 1`,
      [imeiHash, serviceId, now],
    );
    return rows[0] === undefined ? undefined : toOrder(rows[0]);
  }
}

function toOrder(row: Record<string, unknown>): OrderRow {
  return {
    id: String(row['id']),
    checkId: String(row['check_id']),
    tenantId: String(row['tenant_id']),
    providerId: String(row['provider_id']),
    serviceId: String(row['service_id']),
    capability: row['capability'] as Capability,
    referenceId: String(row['reference_id']),
    orderReference: (row['order_reference'] as string | null) ?? undefined,
    // `?? ''` covers a pre-Task-9 row from before the column existed, not a value that was never stored.
    imeiHash: (row['imei_hash'] as string | null) ?? '',
    status: row['status'] as OrderRow['status'],
    attempts: Number(row['attempts'] ?? 0),
    nextPollAt: (row['next_poll_at'] as Date | null) ?? undefined,
    expiresAt: row['expires_at'] as Date,
    createdAt: row['created_at'] as Date,
    settledAt: (row['settled_at'] as Date | null) ?? undefined,
  };
}

class PgIdempotencyRepo implements IdempotencyRepo {
  constructor(private readonly pool: pg.Pool) {}
  /**
   * Claim-or-report, in one statement.
   *
   * `ON CONFLICT DO NOTHING` plus a follow-up SELECT is the only shape that is correct under
   * concurrency: two simultaneous retries both attempt the insert, exactly one succeeds, and the
   * loser reads the winner's row rather than starting a second paid check.
   */
  async claim(
    record: Pick<IdempotencyRecord, 'tenantId' | 'key' | 'requestDigest'>,
  ): Promise<{ claimed: true } | { claimed: false; existing: IdempotencyRecord }> {
    const inserted = await this.pool.query(
      `INSERT INTO idempotency_records (tenant_id, key, request_digest)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, key) DO NOTHING`,
      [record.tenantId, record.key, record.requestDigest],
    );
    if ((inserted.rowCount ?? 0) > 0) return { claimed: true };

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT tenant_id, key, request_digest, check_id, status_code, response_body, created_at,
              completed_at
       FROM idempotency_records WHERE tenant_id = $1 AND key = $2`,
      [record.tenantId, record.key],
    );
    const row = rows[0];
    if (row === undefined) return { claimed: true };
    return {
      claimed: false,
      existing: {
        tenantId: String(row['tenant_id']),
        key: String(row['key']),
        requestDigest: String(row['request_digest']),
        checkId: (row['check_id'] as string | null) ?? undefined,
        statusCode: (row['status_code'] as number | null) ?? undefined,
        responseBody: row['response_body'],
        createdAt: row['created_at'] as Date,
        completedAt: (row['completed_at'] as Date | null) ?? undefined,
      },
    };
  }
  async complete(
    tenantId: string,
    key: string,
    patch: Pick<IdempotencyRecord, 'checkId' | 'statusCode' | 'responseBody'>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_records
       SET check_id = $3, status_code = $4, response_body = $5, completed_at = now()
       WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key, patch.checkId ?? null, patch.statusCode ?? null, JSON.stringify(patch.responseBody)],
    );
  }
}

/** Append-only by a database trigger (ADR-0007); this repo only ever inserts or reads. */
class PgImeiRevealRepo implements ImeiRevealRepo {
  constructor(private readonly pool: pg.Pool) {}
  async record(row: ImeiRevealRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO imei_reveals (id, check_id, actor, reason, revealed_at) VALUES ($1,$2,$3,$4,$5)`,
      [row.id, row.checkId, row.actor, row.reason, row.revealedAt],
    );
  }
  async forCheck(checkId: string): Promise<readonly ImeiRevealRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT id, check_id, actor, reason, revealed_at FROM imei_reveals WHERE check_id = $1',
      [checkId],
    );
    return rows.map((row) => ({
      id: String(row['id']),
      checkId: String(row['check_id']),
      actor: String(row['actor']),
      reason: String(row['reason']),
      revealedAt: row['revealed_at'] as Date,
    }));
  }
}

