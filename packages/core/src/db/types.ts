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

export type LedgerReason =
  | 'topup'
  | 'reserve'
  | 'settle_refund'
  | 'absorbed_provider_bug'
  | 'manual_adjustment';

export interface LedgerEntry {
  readonly id: number;
  readonly tenantId: string;
  readonly delta: number;
  readonly reason: LedgerReason;
  readonly checkId: string | undefined;
  readonly balanceAfter: number;
  readonly idempotencyKey: string | undefined;
  readonly createdAt: Date;
}

export type ReserveResult =
  | { readonly ok: true; readonly reserved: number; readonly balanceAfter: number }
  | { readonly ok: false; readonly shortfall: number; readonly balance: number };

export interface CreditRepo {
  balance(tenantId: string): Promise<number>;
  topUp(tenantId: string, credits: number, idempotencyKey?: string): Promise<number>;
  /**
   * Debits up front. `idempotencyKey` is what makes a retried reserve a no-op rather than a second
   * charge -- enforced by a UNIQUE constraint, not by a read-then-write.
   */
  reserve(args: {
    tenantId: string;
    credits: number;
    checkId: string;
    idempotencyKey: string;
  }): Promise<ReserveResult>;
  /** Refunds reserved-minus-actual as a NEW positive row. The ledger is append-only. */
  refund(args: {
    tenantId: string;
    credits: number;
    checkId: string;
    reason: LedgerReason;
    idempotencyKey: string;
  }): Promise<number>;
  ledger(tenantId: string, limit: number): Promise<readonly LedgerEntry[]>;
  /** Nightly assertion: the cached balance must equal the sum of the ledger. */
  reconcile(tenantId: string): Promise<{ cached: number; summed: number; drift: number }>;
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

export type RestrictionLevel = 'none' | 'throttled' | 'cache_only' | 'no_paid' | 'suspended';

export interface AbuseRepo {
  /** One bucket = (tac, first 3 serial digits). 1000 per TAC; no IMEI is stored. */
  record(tenantId: string, tac: string, bucket: number, windowStart: Date): Promise<void>;
  distinctBuckets(tenantId: string, tac: string, since: Date): Promise<number>;
  restriction(tenantId: string): Promise<{ level: RestrictionLevel; reason: string | undefined }>;
  restrict(tenantId: string, level: RestrictionLevel, reason: string, expiresAt?: Date): Promise<void>;
}

export interface WebhookEndpoint {
  readonly id: string;
  readonly tenantId: string;
  readonly url: string;
  readonly secret: string;
  readonly events: readonly string[];
  readonly active: boolean;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly endpointId: string;
  readonly checkId: string;
  readonly event: string;
  readonly payload: unknown;
  readonly status: 'pending' | 'delivered' | 'failed';
  readonly attempts: number;
  readonly nextRetryAt: Date | undefined;
  readonly lastStatus: number | undefined;
}

export interface WebhookRepo {
  endpointsFor(tenantId: string, event: string): Promise<readonly WebhookEndpoint[]>;
  /**
   * By id, because a queued delivery knows its endpoint but not its tenant. Reconstructing the
   * tenant to search by it was a detour that silently found nothing.
   */
  endpointById(id: string): Promise<WebhookEndpoint | undefined>;
  register(endpoint: WebhookEndpoint): Promise<void>;
  enqueue(delivery: WebhookDelivery): Promise<void>;
  due(now: Date, limit: number): Promise<readonly WebhookDelivery[]>;
  markDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<void>;
}

export interface Repositories {
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
  close(): Promise<void>;
}
