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
import { assertStrongTenantSalt } from './tenant-salt.js';

/**
 * In-memory repositories.
 *
 * Used by the unit suite so the money and contract logic can be exercised without a database.
 * Every method here is written to fail the SAME way Postgres would -- in particular the ledger is
 * genuinely append-only and a reused idempotency key genuinely does not charge twice -- because a
 * fake more forgiving than production hides the bug it was written to catch.
 */

export class MemoryRepositories implements Repositories {
  readonly tenants = new MemoryTenantRepo();
  readonly apiKeys = new MemoryApiKeyRepo();
  readonly credits = new MemoryCreditRepo();
  readonly checks = new MemoryCheckRepo();
  readonly providerCalls = new MemoryProviderCallRepo();
  readonly cache = new MemoryCacheRepo();
  readonly orders = new MemoryOrderRepo();
  readonly idempotency = new MemoryIdempotencyRepo();
  readonly abuse = new MemoryAbuseRepo();
  readonly webhooks = new MemoryWebhookRepo();

  async close(): Promise<void> {}
}

class MemoryTenantRepo implements TenantRepo {
  private readonly rows = new Map<string, Tenant>();
  async byId(id: string): Promise<Tenant | undefined> {
    return this.rows.get(id);
  }
  async create(tenant: Tenant): Promise<void> {
    assertStrongTenantSalt(tenant.imeiSalt);
    this.rows.set(tenant.id, tenant);
  }
}

class MemoryApiKeyRepo implements ApiKeyRepo {
  private readonly byKeyHash = new Map<string, ApiKeyRecord>();
  async byHash(sha256: string): Promise<ApiKeyRecord | undefined> {
    return this.byKeyHash.get(sha256);
  }
  async touch(): Promise<void> {}
  async insert(record: ApiKeyRecord & { keySha256: string }): Promise<void> {
    this.byKeyHash.set(record.keySha256, record);
  }
}

class MemoryCreditRepo implements CreditRepo {
  private readonly balances = new Map<string, number>();
  private readonly entries: LedgerEntry[] = [];
  private readonly usedKeys = new Set<string>();
  private nextId = 1;

  async balance(tenantId: string): Promise<number> {
    return this.balances.get(tenantId) ?? 0;
  }

  async topUp(tenantId: string, credits: number, idempotencyKey?: string): Promise<number> {
    return this.append(tenantId, credits, 'topup', undefined, idempotencyKey);
  }

  /**
   * Debits BEFORE the providers run.
   *
   * Reserving afterwards would let a check that dies halfway leave the tenant billed for nothing,
   * or leave us having paid a supplier for an answer we never charged for.
   */
  async reserve(args: {
    tenantId: string;
    credits: number;
    checkId: string;
    idempotencyKey: string;
  }): Promise<ReserveResult> {
    // A retry is a no-op, not a second charge. Postgres enforces this with a UNIQUE index; doing
    // it here with a read-then-write would misrepresent how the real one behaves concurrently.
    if (this.usedKeys.has(args.idempotencyKey)) {
      const balance = await this.balance(args.tenantId);
      return { ok: true, reserved: 0, balanceAfter: balance };
    }
    const balance = await this.balance(args.tenantId);
    if (balance < args.credits) {
      return { ok: false, shortfall: args.credits - balance, balance };
    }
    const after = this.append(
      args.tenantId,
      -args.credits,
      'reserve',
      args.checkId,
      args.idempotencyKey,
    );
    return { ok: true, reserved: args.credits, balanceAfter: after };
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
    return this.entries
      .filter((e) => e.tenantId === tenantId)
      .slice(-limit)
      .reverse();
  }

  async reconcile(tenantId: string): Promise<{ cached: number; summed: number; drift: number }> {
    const cached = await this.balance(tenantId);
    const summed = this.entries
      .filter((e) => e.tenantId === tenantId)
      .reduce((sum, e) => sum + e.delta, 0);
    return { cached, summed, drift: cached - summed };
  }

  private append(
    tenantId: string,
    delta: number,
    reason: LedgerReason,
    checkId: string | undefined,
    idempotencyKey: string | undefined,
  ): number {
    if (idempotencyKey !== undefined) {
      if (this.usedKeys.has(idempotencyKey)) return this.balances.get(tenantId) ?? 0;
      this.usedKeys.add(idempotencyKey);
    }
    const balanceAfter = (this.balances.get(tenantId) ?? 0) + delta;
    this.balances.set(tenantId, balanceAfter);
    this.entries.push({
      id: this.nextId++,
      tenantId,
      delta,
      reason,
      checkId,
      balanceAfter,
      idempotencyKey,
      createdAt: new Date(),
    });
    return balanceAfter;
  }
}

class MemoryCheckRepo implements CheckRepo {
  private readonly rows = new Map<string, CheckRecord>();
  private readonly sectionRows = new Map<string, Map<string, StoredSection>>();

  async insert(record: CheckRecord): Promise<void> {
    this.rows.set(record.id, record);
  }
  async update(id: string, patch: Partial<CheckRecord>): Promise<void> {
    const existing = this.rows.get(id);
    if (existing !== undefined) this.rows.set(id, { ...existing, ...patch });
  }
  async byId(tenantId: string, id: string): Promise<CheckRecord | undefined> {
    const row = this.rows.get(id);
    return row?.tenantId === tenantId ? row : undefined;
  }
  async putSection(section: StoredSection): Promise<void> {
    let map = this.sectionRows.get(section.checkId);
    if (map === undefined) {
      map = new Map();
      this.sectionRows.set(section.checkId, map);
    }
    map.set(section.capability, section);
  }
  async sections(checkId: string): Promise<readonly StoredSection[]> {
    return [...(this.sectionRows.get(checkId)?.values() ?? [])];
  }
}

class MemoryProviderCallRepo implements ProviderCallRepo {
  readonly rows = new Map<string, ProviderCallRow>();
  async start(row: ProviderCallRow): Promise<void> {
    this.rows.set(row.id, row);
  }
  async finish(id: string, patch: Partial<ProviderCallRow>): Promise<void> {
    const existing = this.rows.get(id);
    if (existing !== undefined) this.rows.set(id, { ...existing, ...patch });
  }
  async costSince(tenantId: string, since: Date): Promise<number> {
    let total = 0;
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.startedAt >= since) total += row.providerCostUsd;
    }
    return total;
  }
}

class MemoryCacheRepo implements CacheRepo {
  private readonly rows = new Map<string, CacheRow>();
  async get(cacheKey: string): Promise<CacheRow | undefined> {
    return this.rows.get(cacheKey);
  }
  async put(row: CacheRow): Promise<void> {
    this.rows.set(row.cacheKey, row);
  }
  async purgeExpired(now: Date): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.expiresAt <= now) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

class MemoryOrderRepo implements OrderRepo {
  private readonly rows = new Map<string, OrderRow>();
  async insert(row: OrderRow): Promise<void> {
    this.rows.set(row.id, row);
  }
  async byReference(referenceId: string): Promise<OrderRow | undefined> {
    return [...this.rows.values()].find((r) => r.referenceId === referenceId);
  }
  async duePolls(now: Date, limit: number): Promise<readonly OrderRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'pending' && r.nextPollAt !== undefined && r.nextPollAt <= now)
      .slice(0, limit);
  }
  async update(id: string, patch: Partial<OrderRow>): Promise<void> {
    const existing = this.rows.get(id);
    if (existing !== undefined) this.rows.set(id, { ...existing, ...patch });
  }
  async openForCheck(checkId: string): Promise<readonly OrderRow[]> {
    return [...this.rows.values()].filter((r) => r.checkId === checkId && r.status === 'pending');
  }
}

class MemoryIdempotencyRepo implements IdempotencyRepo {
  private readonly rows = new Map<string, IdempotencyRecord>();
  private id(tenantId: string, key: string): string {
    return `${tenantId} ${key}`;
  }
  async claim(
    record: Pick<IdempotencyRecord, 'tenantId' | 'key' | 'requestDigest'>,
  ): Promise<{ claimed: true } | { claimed: false; existing: IdempotencyRecord }> {
    const id = this.id(record.tenantId, record.key);
    const existing = this.rows.get(id);
    if (existing !== undefined) return { claimed: false, existing };
    this.rows.set(id, {
      ...record,
      checkId: undefined,
      statusCode: undefined,
      responseBody: undefined,
      createdAt: new Date(),
      completedAt: undefined,
    });
    return { claimed: true };
  }
  async complete(
    tenantId: string,
    key: string,
    patch: Pick<IdempotencyRecord, 'checkId' | 'statusCode' | 'responseBody'>,
  ): Promise<void> {
    const id = this.id(tenantId, key);
    const existing = this.rows.get(id);
    if (existing !== undefined) {
      this.rows.set(id, { ...existing, ...patch, completedAt: new Date() });
    }
  }
}

class MemoryAbuseRepo implements AbuseRepo {
  private readonly buckets = new Map<string, { tenantId: string; tac: string; windowStart: Date; hits: Set<number> }>();
  private readonly restrictions = new Map<string, { level: RestrictionLevel; reason: string | undefined }>();

  async record(tenantId: string, tac: string, bucket: number, windowStart: Date): Promise<void> {
    const key = `${tenantId}|${tac}|${windowStart.toISOString()}`;
    let row = this.buckets.get(key);
    if (row === undefined) {
      row = { tenantId, tac, windowStart, hits: new Set() };
      this.buckets.set(key, row);
    }
    row.hits.add(bucket);
  }
  async distinctBuckets(tenantId: string, tac: string, since: Date): Promise<number> {
    const seen = new Set<number>();
    for (const row of this.buckets.values()) {
      if (row.tenantId !== tenantId || row.tac !== tac || row.windowStart < since) continue;
      for (const bucket of row.hits) seen.add(bucket);
    }
    return seen.size;
  }
  async restriction(tenantId: string): Promise<{ level: RestrictionLevel; reason: string | undefined }> {
    return this.restrictions.get(tenantId) ?? { level: 'none', reason: undefined };
  }
  async restrict(tenantId: string, level: RestrictionLevel, reason: string): Promise<void> {
    this.restrictions.set(tenantId, { level, reason });
  }
}

class MemoryWebhookRepo implements WebhookRepo {
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  readonly deliveries = new Map<string, WebhookDelivery>();

  async endpointsFor(tenantId: string, event: string): Promise<readonly WebhookEndpoint[]> {
    return [...this.endpoints.values()].filter(
      (e) => e.tenantId === tenantId && e.active && e.events.includes(event),
    );
  }
  async endpointById(id: string): Promise<WebhookEndpoint | undefined> {
    return this.endpoints.get(id);
  }
  async register(endpoint: WebhookEndpoint): Promise<void> {
    this.endpoints.set(endpoint.id, endpoint);
  }
  async enqueue(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.set(delivery.id, delivery);
  }
  async due(now: Date, limit: number): Promise<readonly WebhookDelivery[]> {
    return [...this.deliveries.values()]
      .filter((d) => d.status === 'pending' && (d.nextRetryAt === undefined || d.nextRetryAt <= now))
      .slice(0, limit);
  }
  async markDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<void> {
    const existing = this.deliveries.get(id);
    if (existing !== undefined) this.deliveries.set(id, { ...existing, ...patch });
  }
}
