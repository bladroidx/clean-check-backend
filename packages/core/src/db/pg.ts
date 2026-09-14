import pg from 'pg';
import type {
  AbuseRepo,
  ApiKeyRecord,
  ApiKeyRepo,
  CacheRepo,
  CacheRow,
  CheckRecord,
  CheckRepo,
  CreditRepo,
  IdempotencyRecord,
  IdempotencyRepo,
  LedgerEntry,
  LedgerReason,
  OrderRepo,
  OrderRow,
  ProviderCallRepo,
  ProviderCallRow,
  Repositories,
  ReserveResult,
  RestrictionLevel,
  StoredSection,
  Tenant,
  TenantRepo,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookRepo,
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
export const REQUIRED_SCHEMA_VERSION = '20260913000001';

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
  readonly credits: CreditRepo;
  readonly checks: CheckRepo;
  readonly providerCalls: ProviderCallRepo;
  readonly cache: CacheRepo;
  readonly orders: OrderRepo;
  readonly idempotency: IdempotencyRepo;
  readonly abuse: AbuseRepo;
  readonly webhooks: WebhookRepo;

  constructor(private readonly pool: pg.Pool) {
    this.tenants = new PgTenantRepo(pool);
    this.apiKeys = new PgApiKeyRepo(pool);
    this.credits = new PgCreditRepo(pool);
    this.checks = new PgCheckRepo(pool);
    this.providerCalls = new PgProviderCallRepo(pool);
    this.cache = new PgCacheRepo(pool);
    this.orders = new PgOrderRepo(pool);
    this.idempotency = new PgIdempotencyRepo(pool);
    this.abuse = new PgAbuseRepo(pool);
    this.webhooks = new PgWebhookRepo(pool);
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
    await this.pool.query(
      `INSERT INTO credit_accounts (tenant_id, balance_credits) VALUES ($1, 0)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenant.id],
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

class PgCreditRepo implements CreditRepo {
  constructor(private readonly pool: pg.Pool) {}

  async balance(tenantId: string): Promise<number> {
    const { rows } = await this.pool.query<{ balance_credits: string }>(
      'SELECT balance_credits FROM credit_accounts WHERE tenant_id = $1',
      [tenantId],
    );
    return Number(rows[0]?.balance_credits ?? 0);
  }

  async topUp(tenantId: string, credits: number, idempotencyKey?: string): Promise<number> {
    return this.append(tenantId, credits, 'topup', undefined, idempotencyKey);
  }

  /**
   * Atomic, idempotent debit.
   *
   * `FOR UPDATE` serialises concurrent checks for one tenant, so two checks cannot each see enough
   * balance and both spend it. The ledger insert carries the idempotency key under a UNIQUE
   * constraint, so a retry raises 23505 and we return the already-charged state instead of
   * charging again -- a read-then-write would let a retry slip through between the two statements.
   */
  async reserve(args: {
    tenantId: string;
    credits: number;
    checkId: string;
    idempotencyKey: string;
  }): Promise<ReserveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ balance_credits: string }>(
        'SELECT balance_credits FROM credit_accounts WHERE tenant_id = $1 FOR UPDATE',
        [args.tenantId],
      );
      const balance = Number(rows[0]?.balance_credits ?? 0);

      if (balance < args.credits) {
        await client.query('ROLLBACK');
        return { ok: false, shortfall: args.credits - balance, balance };
      }

      const after = balance - args.credits;
      await client.query(
        `INSERT INTO credit_ledger (tenant_id, delta, reason, check_id, balance_after, idempotency_key)
         VALUES ($1,$2,'reserve',$3,$4,$5)`,
        [args.tenantId, -args.credits, args.checkId, after, args.idempotencyKey],
      );
      // Same transaction as the ledger row: a balance that can disagree with its ledger is not an
      // accounting system.
      await client.query(
        'UPDATE credit_accounts SET balance_credits = $2, updated_at = now() WHERE tenant_id = $1',
        [args.tenantId, after],
      );
      await client.query('COMMIT');
      return { ok: true, reserved: args.credits, balanceAfter: after };
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        // Already reserved under this key. Not an error: it is the guarantee working.
        return { ok: true, reserved: 0, balanceAfter: await this.balance(args.tenantId) };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async refund(args: {
    tenantId: string;
    credits: number;
    checkId: string;
    reason: LedgerReason;
    idempotencyKey: string;
  }): Promise<number> {
    if (args.credits <= 0) return this.balance(args.tenantId);
    return this.append(args.tenantId, args.credits, args.reason, args.checkId, args.idempotencyKey);
  }

  async ledger(tenantId: string, limit: number): Promise<readonly LedgerEntry[]> {
    const { rows } = await this.pool.query<{
      id: string;
      tenant_id: string;
      delta: string;
      reason: string;
      check_id: string | null;
      balance_after: string;
      idempotency_key: string | null;
      created_at: Date;
    }>(
      `SELECT id, tenant_id, delta, reason, check_id, balance_after, idempotency_key, created_at
       FROM credit_ledger WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      tenantId: row.tenant_id,
      delta: Number(row.delta),
      reason: row.reason as LedgerReason,
      checkId: row.check_id ?? undefined,
      balanceAfter: Number(row.balance_after),
      idempotencyKey: row.idempotency_key ?? undefined,
      createdAt: row.created_at,
    }));
  }

  async reconcile(tenantId: string): Promise<{ cached: number; summed: number; drift: number }> {
    const { rows } = await this.pool.query<{ cached: string; summed: string }>(
      `SELECT
         (SELECT balance_credits FROM credit_accounts WHERE tenant_id = $1) AS cached,
         (SELECT COALESCE(SUM(delta),0) FROM credit_ledger WHERE tenant_id = $1) AS summed`,
      [tenantId],
    );
    const cached = Number(rows[0]?.cached ?? 0);
    const summed = Number(rows[0]?.summed ?? 0);
    return { cached, summed, drift: cached - summed };
  }

  private async append(
    tenantId: string,
    delta: number,
    reason: LedgerReason,
    checkId: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ balance_credits: string }>(
        'SELECT balance_credits FROM credit_accounts WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      const after = Number(rows[0]?.balance_credits ?? 0) + delta;
      await client.query(
        `INSERT INTO credit_ledger (tenant_id, delta, reason, check_id, balance_after, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, delta, reason, checkId ?? null, after, idempotencyKey ?? null],
      );
      await client.query(
        'UPDATE credit_accounts SET balance_credits = $2, updated_at = now() WHERE tenant_id = $1',
        [tenantId, after],
      );
      await client.query('COMMIT');
      return after;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) return this.balance(tenantId);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PgCheckRepo implements CheckRepo {
  constructor(private readonly pool: pg.Pool) {}

  async insert(record: CheckRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO checks
         (id, tenant_id, imei_hash, subject_hash, imei_masked, tac, requested_capabilities,
          status, idempotency_key, credits_charged, verdict, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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

  async byId(tenantId: string, id: string): Promise<CheckRecord | undefined> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, tenant_id, imei_hash, subject_hash, imei_masked, tac, requested_capabilities,
              status, idempotency_key, credits_charged, verdict, created_at, completed_at
       FROM checks WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
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
    };
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
    await this.pool.query(
      `UPDATE provider_calls SET
         status = COALESCE($2, status), latency_ms = COALESCE($3, latency_ms),
         billable = COALESCE($4, billable), error_code = COALESCE($5, error_code),
         finished_at = COALESCE($6, finished_at)
       WHERE id = $1`,
      [id, patch.status ?? null, patch.latencyMs ?? null, patch.billable ?? null, patch.errorCode ?? null, patch.finishedAt ?? null],
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
          order_reference, status, attempts, next_poll_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        row.id, row.checkId, row.tenantId, row.providerId, row.serviceId, row.capability,
        row.referenceId, row.orderReference ?? null, row.status, row.attempts,
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

class PgAbuseRepo implements AbuseRepo {
  constructor(private readonly pool: pg.Pool) {}
  async record(tenantId: string, tac: string, bucket: number, windowStart: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO enumeration_buckets (tenant_id, tac, bucket, window_start, hits)
       VALUES ($1,$2,$3,$4,1)
       ON CONFLICT (tenant_id, tac, bucket, window_start) DO UPDATE SET hits = enumeration_buckets.hits + 1`,
      [tenantId, tac, bucket, windowStart],
    );
  }
  async distinctBuckets(tenantId: string, tac: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT bucket) AS count FROM enumeration_buckets
       WHERE tenant_id = $1 AND tac = $2 AND window_start >= $3`,
      [tenantId, tac, since],
    );
    return Number(rows[0]?.count ?? 0);
  }
  async restriction(tenantId: string): Promise<{ level: RestrictionLevel; reason: string | undefined }> {
    const { rows } = await this.pool.query<{ level: string; reason: string | null; expires_at: Date | null }>(
      'SELECT level, reason, expires_at FROM tenant_restrictions WHERE tenant_id = $1',
      [tenantId],
    );
    const row = rows[0];
    if (row === undefined) return { level: 'none', reason: undefined };
    if (row.expires_at !== null && row.expires_at <= new Date()) {
      return { level: 'none', reason: undefined };
    }
    return { level: row.level as RestrictionLevel, reason: row.reason ?? undefined };
  }
  async restrict(tenantId: string, level: RestrictionLevel, reason: string, expiresAt?: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_restrictions (tenant_id, level, reason, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE SET
         level = EXCLUDED.level, reason = EXCLUDED.reason,
         expires_at = EXCLUDED.expires_at, applied_at = now()`,
      [tenantId, level, reason, expiresAt ?? null],
    );
  }
}

class PgWebhookRepo implements WebhookRepo {
  constructor(private readonly pool: pg.Pool) {}
  async endpointsFor(tenantId: string, event: string): Promise<readonly WebhookEndpoint[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, tenant_id, url, secret, events, active FROM webhook_endpoints
       WHERE tenant_id = $1 AND active AND $2 = ANY(events)`,
      [tenantId, event],
    );
    return rows.map((row) => ({
      id: String(row['id']),
      tenantId: String(row['tenant_id']),
      url: String(row['url']),
      secret: String(row['secret']),
      events: row['events'] as string[],
      active: row['active'] === true,
    }));
  }
  async endpointById(id: string): Promise<WebhookEndpoint | undefined> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT id, tenant_id, url, secret, events, active FROM webhook_endpoints WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: String(row['id']),
      tenantId: String(row['tenant_id']),
      url: String(row['url']),
      secret: String(row['secret']),
      events: row['events'] as string[],
      active: row['active'] === true,
    };
  }
  async register(endpoint: WebhookEndpoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_endpoints (id, tenant_id, url, secret, events, active)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [endpoint.id, endpoint.tenantId, endpoint.url, endpoint.secret, endpoint.events, endpoint.active],
    );
  }
  async enqueue(delivery: WebhookDelivery): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_deliveries
         (id, endpoint_id, check_id, event, payload, status, attempts, next_retry_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        delivery.id, delivery.endpointId, delivery.checkId, delivery.event,
        JSON.stringify(delivery.payload), delivery.status, delivery.attempts,
        delivery.nextRetryAt ?? null,
      ],
    );
  }
  async due(now: Date, limit: number): Promise<readonly WebhookDelivery[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, endpoint_id, check_id, event, payload, status, attempts, next_retry_at, last_status
       FROM webhook_deliveries
       WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1)
       ORDER BY created_at LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((row) => ({
      id: String(row['id']),
      endpointId: String(row['endpoint_id']),
      checkId: String(row['check_id']),
      event: String(row['event']),
      payload: row['payload'],
      status: row['status'] as WebhookDelivery['status'],
      attempts: Number(row['attempts'] ?? 0),
      nextRetryAt: (row['next_retry_at'] as Date | null) ?? undefined,
      lastStatus: (row['last_status'] as number | null) ?? undefined,
    }));
  }
  async markDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_deliveries SET
         status = COALESCE($2, status), attempts = COALESCE($3, attempts),
         next_retry_at = $4, last_status = COALESCE($5, last_status),
         delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END
       WHERE id = $1`,
      [id, patch.status ?? null, patch.attempts ?? null, patch.nextRetryAt ?? null, patch.lastStatus ?? null],
    );
  }
}

/** 23505 is unique_violation. It is the mechanism, not an error, wherever idempotency is claimed. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
