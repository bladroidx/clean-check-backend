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
  readonly checks = new MemoryCheckRepo();
  readonly providerCalls = new MemoryProviderCallRepo();
  readonly cache = new MemoryCacheRepo();
  readonly orders = new MemoryOrderRepo();
  readonly idempotency = new MemoryIdempotencyRepo();
  readonly locks = new MemoryProviderLock();
  readonly reveals = new MemoryImeiRevealRepo();

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
  async listAll(): Promise<readonly Tenant[]> {
    return [...this.rows.values()];
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

class MemoryCheckRepo implements CheckRepo {
  private readonly rows = new Map<string, CheckRecord>();
  private readonly sectionRows = new Map<string, Map<string, StoredSection>>();
  /**
   * The ciphertext lives here, not on the row returned by `byId` -- mirrors Postgres, where
   * `byId` simply does not SELECT `imei_encrypted`/`imei_key_version`. `encryptedImei` is the
   * only read path (ADR-0007).
   */
  private readonly ciphertext = new Map<string, { imeiEncrypted: Buffer; imeiKeyVersion: number }>();

  async insert(record: CheckRecord): Promise<void> {
    this.rows.set(record.id, record);
    if (record.imeiEncrypted !== undefined && record.imeiKeyVersion !== undefined) {
      this.ciphertext.set(record.id, {
        imeiEncrypted: record.imeiEncrypted,
        imeiKeyVersion: record.imeiKeyVersion,
      });
    }
  }
  async update(id: string, patch: Partial<CheckRecord>): Promise<void> {
    const existing = this.rows.get(id);
    if (existing !== undefined) this.rows.set(id, { ...existing, ...patch });
  }
  async byId(tenantId: string, id: string, tier?: 'free' | 'deep'): Promise<CheckSummary | undefined> {
    const row = this.rows.get(id);
    if (row?.tenantId !== tenantId) return undefined;
    if (tier !== undefined && row.tier !== tier) return undefined;
    const { imeiEncrypted: _imeiEncrypted, imeiKeyVersion: _imeiKeyVersion, ...summary } = row;
    return summary;
  }
  async encryptedImei(id: string): Promise<{ imeiEncrypted: Buffer; imeiKeyVersion: number } | undefined> {
    return this.ciphertext.get(id);
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
  async costSinceForProvider(providerId: string, since: Date): Promise<number> {
    let total = 0;
    for (const row of this.rows.values()) {
      if (row.providerId === providerId && row.startedAt >= since) total += row.providerCostUsd;
    }
    return total;
  }
}

/**
 * In-process stand-in for the Postgres advisory lock.
 *
 * FIFO-ish mutual exclusion per name, built as a chain of promises rather than a queue array: each
 * caller's `mine` promise becomes the new tail, and a caller only proceeds once the PREVIOUS tail
 * settles. The subtlety is the timeout path -- a waiter that gives up must not remove itself from
 * the chain (the next waiter is already linked to it), so it still hands off its slot with
 * `void previous.then(release)` and simply never runs `fn`. The map entry for a name is deleted
 * once its tail is the one this call installed, so an idle lock name does not grow the map forever.
 */
class MemoryProviderLock implements ProviderLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(
    name: string,
    waitMs: number,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(name, tail);

    let timer: NodeJS.Timeout | undefined;
    const acquired = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (!acquired) {
      // We never got the lock, so we never run `fn`. But the caller behind us is already chained
      // onto `mine` via `tail`, so we still have to release it once the holder ahead of us is done
      // -- otherwise every later waiter for this name hangs forever.
      void previous.then(release);
      return { acquired: false };
    }
    try {
      return { acquired: true, value: await fn() };
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
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
  async openForImei(imeiHash: string, serviceId: string, now: Date): Promise<OrderRow | undefined> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.imeiHash === imeiHash && r.serviceId === serviceId && r.status === 'pending' && r.expiresAt > now,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }
}

class MemoryImeiRevealRepo implements ImeiRevealRepo {
  private readonly rows: ImeiRevealRecord[] = [];
  async record(row: ImeiRevealRecord): Promise<void> {
    this.rows.push(row);
  }
  async forCheck(checkId: string): Promise<readonly ImeiRevealRecord[]> {
    return this.rows.filter((r) => r.checkId === checkId);
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

