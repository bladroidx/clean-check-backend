import type { Capability, Coverage, Outcome, SectionResult, Verdict } from '@imei-check/contract';

/**
 * The persistence contract.
 *
 * Interfaces rather than a concrete client, for one reason that matters: the money rules --
 * reserve/settle, the append-only ledger, what is and is not charged -- are the highest-risk logic
 * in the service, and they must be testable without a database. The in-memory implementation is
 * not a convenience for tests, it is what lets the ledger concurrency cases be written at all.
 */

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly plan: string;
  readonly status: 'active' | 'suspended';
  /** Per-tenant, so `subject.imei_hash` correlates within a tenant and nowhere else. */
  readonly imeiSalt: string;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly revokedAt: Date | undefined;
  readonly expiresAt: Date | undefined;
}

export interface TenantRepo {
  byId(id: string): Promise<Tenant | undefined>;
  create(tenant: Tenant): Promise<void>;
  /**
   * Every tenant the nightly reconciliation must assert a ledger for. Suspended tenants are
   * included: a suspended account still holds a balance, and a drift that appeared before the
   * suspension is exactly the kind that never gets found if the sweep skips it.
   */
  listAll(): Promise<readonly Tenant[]>;
}

export interface ApiKeyRepo {
  /** Looked up by SHA-256 of the presented key. Never by the key itself. */
  byHash(sha256: string): Promise<ApiKeyRecord | undefined>;
  touch(id: string, at: Date): Promise<void>;
  insert(record: ApiKeyRecord & { keySha256: string }): Promise<void>;
}

export interface CheckRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly imeiHash: string;
  readonly subjectHash: string;
  readonly imeiMasked: string;
  readonly tac: string | undefined;
  readonly requestedCapabilities: readonly Capability[];
  readonly status: 'pending' | 'partial' | 'complete' | 'expired';
  readonly idempotencyKey: string | undefined;
  readonly creditsCharged: number;
  readonly verdict: Verdict | undefined;
  readonly createdAt: Date;
  readonly completedAt: Date | undefined;
}

export interface StoredSection {
  readonly checkId: string;
  readonly capability: Capability;
  readonly outcome: Outcome;
  readonly section: SectionResult;
}

export interface CheckRepo {
  insert(record: CheckRecord): Promise<void>;
  update(
    id: string,
    patch: Partial<Pick<CheckRecord, 'status' | 'verdict' | 'creditsCharged' | 'completedAt'>>,
  ): Promise<void>;
  byId(tenantId: string, id: string): Promise<CheckRecord | undefined>;
  putSection(section: StoredSection): Promise<void>;
  sections(checkId: string): Promise<readonly StoredSection[]>;
}

export interface ProviderCallRow {
  readonly id: string;
  readonly checkId: string | undefined;
  readonly tenantId: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly capability: Capability;
  readonly status: 'in_flight' | 'answered' | 'pending' | 'rejected' | 'failed';
  readonly providerCostUsd: number;
  readonly creditsCharged: number;
  readonly billable: boolean;
  readonly latencyMs: number | undefined;
  readonly errorCode: string | undefined;
  readonly startedAt: Date;
  readonly finishedAt: Date | undefined;
}

export interface ProviderCallRepo {
  /** Written BEFORE the HTTP call. See the comment on `RouterHooks.onCallStart`. */
  start(row: ProviderCallRow): Promise<void>;
  finish(id: string, patch: Partial<ProviderCallRow>): Promise<void>;
  costSince(tenantId: string, since: Date): Promise<number>;
  /** Same shape as `costSince`, keyed by provider rather than tenant -- the daily spend cap. */
  costSinceForProvider(providerId: string, since: Date): Promise<number>;
}

/**
 * A cross-process advisory lock, named rather than typed to the resource it protects.
 *
 * imei24 allows exactly one job in flight at a time, per API key, across every process that might
 * call it -- the API and the worker both poll. This is the only guard in the service that must be
 * true across processes rather than just within one, which is why it needs its own repository
 * rather than an in-process mutex.
 */
export interface ProviderLock {
  /** Runs fn holding the named cross-process lock, or returns undefined if it could not be taken within waitMs. */
  withLock<T>(
    name: string,
    waitMs: number,
    fn: () => Promise<T>,
  ): Promise<{ readonly acquired: true; readonly value: T } | { readonly acquired: false }>;
}

export interface CacheRow {
  readonly cacheKey: string;
  readonly capability: Capability;
  readonly field: string;
  readonly value: string;
  readonly rawLabel: string | undefined;
  readonly coverage: Coverage;
  readonly providerId: string | undefined;
  readonly checkedAt: Date;
  readonly expiresAt: Date;
}

export interface CacheRepo {
  get(cacheKey: string): Promise<CacheRow | undefined>;
  put(row: CacheRow): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}

export interface OrderRow {
  readonly id: string;
  readonly checkId: string;
  readonly tenantId: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly capability: Capability;
  readonly referenceId: string;
  readonly orderReference: string | undefined;
  /**
   * The INTERNAL cache/dedupe key hash for this order's check -- `HMAC-SHA256(SERVER_PEPPER,
   * digits)`, never returned to a caller -- not the tenant-facing `subject.imei_hash` (which is
   * salted per tenant and could not key a cross-tenant cache). Carried here so async settlement
   * can write the field cache the same way the synchronous path does (Task 8). Task 9 adds the
   * `imei_hash` column to `provider_orders`; until then a Postgres row reads back with `?? ''`
   * rather than a value that was never stored.
   */
  readonly imeiHash: string;
  readonly status: 'pending' | 'answered' | 'rejected' | 'abandoned';
  readonly attempts: number;
  readonly nextPollAt: Date | undefined;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly settledAt: Date | undefined;
}

export interface OrderRepo {
  insert(row: OrderRow): Promise<void>;
  byReference(referenceId: string): Promise<OrderRow | undefined>;
  duePolls(now: Date, limit: number): Promise<readonly OrderRow[]>;
  update(id: string, patch: Partial<OrderRow>): Promise<void>;
  openForCheck(checkId: string): Promise<readonly OrderRow[]>;
}

export interface IdempotencyRecord {
  readonly tenantId: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly checkId: string | undefined;
  readonly statusCode: number | undefined;
  readonly responseBody: unknown;
  readonly createdAt: Date;
  readonly completedAt: Date | undefined;
}

export interface IdempotencyRepo {
  /** Inserts if absent. Returns the EXISTING row when the key has been seen, which is the point. */
  claim(record: Pick<IdempotencyRecord, 'tenantId' | 'key' | 'requestDigest'>): Promise<
    { readonly claimed: true } | { readonly claimed: false; readonly existing: IdempotencyRecord }
  >;
  complete(
    tenantId: string,
    key: string,
    patch: Pick<IdempotencyRecord, 'checkId' | 'statusCode' | 'responseBody'>,
  ): Promise<void>;
}

export interface Repositories {
  readonly tenants: TenantRepo;
  readonly apiKeys: ApiKeyRepo;
  readonly checks: CheckRepo;
  readonly providerCalls: ProviderCallRepo;
  readonly cache: CacheRepo;
  readonly orders: OrderRepo;
  readonly idempotency: IdempotencyRepo;
  readonly locks: ProviderLock;
  close(): Promise<void>;
}
