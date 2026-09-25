import { randomUUID } from 'node:crypto';
import {
  DISCLAIMER,
  SCHEMA_VERSION,
  assertEnvelopeInvariants,
  deriveVerdict,
  unavailable,
  type Capability,
  type CheckReport,
  type SectionResult,
} from '@imei-check/contract';
import type { Imei, TacDirectory } from '@imei-check/identity';
import {
  capabilityOf,
  fieldsFor,
  type CallResult,
  type CanonicalField,
  type FieldValue,
  type Router,
} from '@imei-check/providers';
import type { FieldCache } from '@imei-check/core';
import type { Metrics } from '@imei-check/core';
import type { Repositories } from '@imei-check/core';
import { assembleSection, deriveWarrantyStatus } from '@imei-check/core';
import { coverageFor } from '@imei-check/core';
import { identityCoverage } from '@imei-check/core';

/**
 * One check, end to end, in one of two tiers.
 *
 * - **`free`** answers from the in-process TAC directory and nothing else. Its call site has no
 *   router to hand over, so "the free check never spends supplier money" is true by construction
 *   rather than by a branch someone could get wrong. Anything it cannot answer offline is
 *   `unavailable(requires_deep_check)` -- stated, never dropped.
 * - **`deep`** buys what the caller asked for, and only that.
 *
 * The deep ordering is load-bearing:
 *
 * 1. **Cache before providers.** A cached capability is served straight from the field cache, so
 *    checking it first saves the supplier call.
 * 2. **Fewest services.** The router plans one order per SERVICE, not per capability: imei24
 *    charges again for every repeat, and an Apple all-in-one answers four capabilities at once.
 * 3. **Attach before placing.** An order already running for this device and service is joined,
 *    not placed again -- for the same reason.
 *
 * There is no reserve/settle step: billing is permanently off in single-consumer mode. The report
 * honestly states `credits_charged: 0` because nothing was ever charged.
 */

export interface RunCheckDeps {
  readonly repos: Repositories;
  /** Required for `tier: 'deep'`; the free route never passes one. */
  readonly router?: Router;
  readonly cache: FieldCache;
  readonly tacDirectory: TacDirectory;
  readonly metrics: Metrics;
  readonly now?: () => Date;
}

export interface RunCheckRequest {
  readonly tenantId: string;
  readonly tenantSalt: string;
  readonly imei: Imei;
  /** `HMAC(SERVER_PEPPER, digits)` -- the internal key. Never returned. */
  readonly imeiHash: string;
  readonly capabilities: readonly Capability[];
  readonly maxAgeSeconds: number | undefined;
  readonly idempotencyKey: string | undefined;
  readonly signal: AbortSignal;
  readonly tier: 'free' | 'deep';
}

/** Answered from the in-process directory. Free, offline, and the only thing the free tier answers. */
export const OFFLINE_CAPABILITIES: readonly Capability[] = ['identity.model'];

/** Computed from other fields. Never bought, never cached (ADR-0004). */
const DERIVED_CAPABILITIES: readonly Capability[] = ['warranty.status'];

/**
 * A standard order is polled by the worker for this long, then abandoned as
 * `unavailable(awaiting_provider_timed_out)` (spec section 5: 30 minutes).
 */
const ORDER_TTL_MS = 30 * 60 * 1000;
const FIRST_POLL_MS = 5 * 60 * 1000;

export async function runCheck(deps: RunCheckDeps, request: RunCheckRequest): Promise<CheckReport> {
  const router = deps.router;
  if (request.tier === 'deep' && router === undefined) throw new Error('deep tier requires a router');

  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  // Hyphens kept: 32 bare hex characters contain a 14-digit run about 1.3% of the time, and an
  // id that looks like an IMEI trips the log tripwire every time its GET URL is logged.
  const checkId = `chk_${randomUUID()}`;
  const tac = request.imei.typeAllocationCode;

  // A derived capability is only as good as the fact it is derived from: asking a deep check for
  // warranty status without buying the purchase date would return `unavailable` every time.
  const capabilities: readonly Capability[] =
    request.tier === 'deep' &&
    request.capabilities.includes('warranty.status') &&
    !request.capabilities.includes('warranty.purchase_date')
      ? [...request.capabilities, 'warranty.purchase_date']
      : request.capabilities;

  await deps.repos.checks.insert({
    id: checkId,
    tenantId: request.tenantId,
    imeiHash: request.imeiHash,
    subjectHash: request.imei.hmac(Buffer.from(request.tenantSalt, 'utf8')),
    imeiMasked: request.imei.masked(),
    tac,
    requestedCapabilities: capabilities,
    status: 'pending',
    idempotencyKey: request.idempotencyKey,
    creditsCharged: 0,
    verdict: undefined,
    createdAt: startedAt,
    completedAt: undefined,
    tier: request.tier,
    // Task 11 encrypts the IMEI for both tiers (ADR-0007).
    imeiEncrypted: undefined,
    imeiKeyVersion: undefined,
  });

  const sections = new Map<Capability, SectionResult>();
  const breakdown: Array<{ capability: Capability; credits: number; cached: boolean }> = [];
  /** Fields resolved during this run, so a derived capability can read them without re-buying. */
  const resolvedFields = new Map<CanonicalField, FieldValue>();
  const record = (capability: Capability, section: SectionResult, cached = false): void => {
    sections.set(capability, section);
    breakdown.push({ capability, credits: 0, cached });
    deps.metrics.sectionOutcome.inc({
      capability,
      outcome: section.outcome,
      reason: section.reason ?? 'none',
    });
  };

  // ---- 1. Offline capabilities. Free. The route keeps them off the deep tier.
  for (const capability of capabilities) {
    if (!OFFLINE_CAPABILITIES.includes(capability)) continue;
    record(capability, offlineIdentity(deps.tacDirectory, request.imei, startedAt));
    const entry = deps.tacDirectory.lookup(tac);
    if (entry !== undefined) {
      resolvedFields.set('identity.model', { field: 'identity.model', value: entry.model });
      resolvedFields.set('identity.manufacturer', {
        field: 'identity.manufacturer',
        value: entry.manufacturer,
      });
    }
  }

  if (router === undefined || request.tier === 'free') {
    // ---- Free tier: everything else needs a paid lookup. Stated, not dropped -- a client that
    // asked for the block list and got no section at all could read the silence as "clean".
    for (const capability of capabilities) {
      if (OFFLINE_CAPABILITIES.includes(capability)) continue;
      record(
        capability,
        unavailable({
          capability,
          checkedAt: startedAt,
          coverage: coverageFor(capability, deps.tacDirectory),
          reason: 'requires_deep_check',
          detail: 'This check needs a paid lookup. Request it from POST /v1/deep_checks.',
        }),
      );
    }
  } else {
    await resolvePaid({
      deps,
      router,
      request,
      capabilities,
      checkId,
      startedAt,
      record,
      resolvedFields,
    });

    // ---- 5. Derived capabilities. Free arithmetic over facts we already hold.
    for (const capability of capabilities) {
      if (!DERIVED_CAPABILITIES.includes(capability)) continue;
      const purchase = resolvedFields.get('warranty.purchase_date');
      const coverage = coverageFor(capability, deps.tacDirectory);
      record(
        capability,
        purchase !== undefined
          ? deriveWarrantyStatus({
              purchaseDateIso: purchase.value,
              coverage,
              checkedAt: startedAt,
            })
          : unavailable({
              capability,
              checkedAt: startedAt,
              coverage,
              reason: 'capability_not_supported_for_device',
              detail:
                'Warranty status is derived from a purchase date, and no purchase date was ' +
                'available for this device.',
            }),
      );
    }
  }

  const completedAt = now();
  const list = [...sections.values()];
  const summary = deriveVerdict(list);
  const anyPending = list.some((s) => s.outcome === 'inconclusive' && s.reason === 'awaiting_provider');

  const report: CheckReport = {
    schema_version: SCHEMA_VERSION,
    check_id: checkId,
    status: anyPending ? 'partial' : 'complete',
    subject: {
      imei_masked: request.imei.masked(),
      imei_hash: request.imei.hmac(Buffer.from(request.tenantSalt, 'utf8')),
      tac,
      luhn_valid: true,
    },
    requested_at: startedAt.toISOString(),
    completed_at: anyPending ? null : completedAt.toISOString(),
    sections: Object.fromEntries(sections) as CheckReport['sections'],
    summary: {
      verdict: summary.verdict,
      reasons: reasonsFor(list),
      sections_unavailable: summary.sections_unavailable,
    },
    // Honest, not merely zeroed: there is no billing at all any more. `breakdown` keeps which
    // capabilities ran and whether they were cached; `credits` is always 0.
    billing: {
      credits_charged: 0,
      breakdown,
    },
    disclaimer: DISCLAIMER,
  };

  assertEnvelopeInvariants(report);

  for (const [capability, section] of sections) {
    await deps.repos.checks.putSection({
      checkId,
      capability,
      outcome: section.outcome,
      section,
    });
  }
  await deps.repos.checks.update(checkId, {
    status: report.status,
    verdict: report.summary.verdict,
    creditsCharged: 0,
    completedAt: anyPending ? undefined : completedAt,
  });

  return report;
}

/**
 * Steps 2-4 of a deep check: cache, plan, then attach-or-place one order per planned call.
 */
async function resolvePaid(args: {
  deps: RunCheckDeps;
  router: Router;
  request: RunCheckRequest;
  capabilities: readonly Capability[];
  checkId: string;
  startedAt: Date;
  record: (capability: Capability, section: SectionResult, cached?: boolean) => void;
  resolvedFields: Map<CanonicalField, FieldValue>;
}): Promise<void> {
  const { deps, router, request, checkId, startedAt, record, resolvedFields } = args;
  const tac = request.imei.typeAllocationCode;

  const paid = args.capabilities.filter(
    (c) => !OFFLINE_CAPABILITIES.includes(c) && !DERIVED_CAPABILITIES.includes(c),
  );

  // ---- 2. Read the cache first: a fresh hit places no order.
  const cached = new Map<Capability, Awaited<ReturnType<FieldCache['read']>>>();
  for (const capability of paid) {
    const hits = await deps.cache.read({
      imeiHash: request.imeiHash,
      capability,
      fields: fieldsFor(capability),
      now: startedAt,
      ...(request.maxAgeSeconds !== undefined ? { maxAgeSeconds: request.maxAgeSeconds } : {}),
    });
    // A partial hit is not a hit: a section whose deciding field is stale would carry a
    // `checked_at` that is true of half of it.
    const complete = hits.length > 0 && hasDecidingField(capability, hits.map((h) => h.field));
    if (complete) cached.set(capability, hits);
    deps.metrics.cacheHit.inc({ capability, result: complete ? 'hit' : 'miss' });
  }

  for (const [capability, hits] of cached) {
    record(capability, fromCache(capability, hits, deps, startedAt), true);
    for (const hit of hits) {
      resolvedFields.set(hit.field, { field: hit.field, value: hit.value, ...(hit.rawLabel !== undefined ? { rawLabel: hit.rawLabel } : {}) });
    }
  }

  // ---- 3. Plan the fewest services that cover what is left.
  const toBuy = paid.filter((c) => !cached.has(c));
  if (toBuy.length === 0) return;
  const manufacturer = deps.tacDirectory.lookup(tac)?.manufacturer;
  const { calls, uncovered } = router.plan(toBuy, tac, manufacturer);

  for (const capability of uncovered) {
    record(
      capability,
      assembleSection({
        capability,
        // A gap in OUR supply, not a supplier fault -- and never a pass.
        outcome: {
          kind: 'failed',
          reason: 'no_provider_configured',
          detail: 'No data source is configured for this check.',
        },
        coverage: coverageFor(capability, deps.tacDirectory),
        checkedAt: startedAt,
      }),
    );
  }

  // ---- 4. One order per call: attach to one already running, or place it.
  for (const call of calls) {
    const head = call.candidates[0];
    // imei24 charges every repeat, so an order already open for this device and service is joined
    // rather than bought again. No runCall, so no provider_calls row: nothing is being spent.
    const open =
      head !== undefined
        ? await deps.repos.orders.openForImei(request.imeiHash, head.service.serviceId)
        : undefined;

    const attach = head !== undefined && open !== undefined && open.orderReference !== undefined;

    // The deep-check budget (or the client) is gone: do not place this order. Joining an open one
    // above costs nothing and is still allowed; buying one nobody will wait for is not.
    if (!attach && request.signal.aborted) {
      for (const capability of call.capabilities) {
        record(
          capability,
          assembleSection({
            capability,
            outcome: {
              kind: 'failed',
              reason: 'timeout',
              detail: 'Not attempted: the deep-check time budget was spent.',
            },
            coverage: coverageFor(capability, deps.tacDirectory),
            checkedAt: startedAt,
          }),
        );
      }
      continue;
    }

    const routed: CallResult =
      attach && head !== undefined && open?.orderReference !== undefined
        ? {
            capability: firstOf(call.capabilities),
            capabilities: call.capabilities,
            attempts: [],
            service: head.service,
            outcome: { kind: 'pending', orderReference: open.orderReference },
          }
        : await router.runCall({ call, imeiDigits: request.imei.digits, signal: request.signal });

    recordAttemptMetrics(deps, routed);

    const coverageOf = (capability: Capability) => coverageFor(capability, deps.tacDirectory);

    // Cache and remember whatever we actually learned, even from a section that did not pass.
    // Once per CALL: each field is written once, under its own capability's coverage.
    if (routed.outcome.kind === 'answered') {
      const byCapability = new Map<Capability, FieldValue[]>();
      for (const field of routed.outcome.fields) {
        resolvedFields.set(field.field, field);
        const owner = capabilityOf(field.field);
        byCapability.set(owner, [...(byCapability.get(owner) ?? []), field]);
      }
      const providerId = routed.attempts[routed.attempts.length - 1]?.providerId ?? 'unknown';
      for (const [owner, fields] of byCapability) {
        await deps.cache.write({
          imeiHash: request.imeiHash,
          fields,
          coverage: coverageOf(owner),
          providerId,
          checkedAt: startedAt,
        });
      }
    }

    const last = routed.attempts[routed.attempts.length - 1];
    for (const [index, capability] of call.capabilities.entries()) {
      record(
        capability,
        assembleSection({
          capability,
          outcome: routed.outcome,
          coverage: coverageOf(capability),
          checkedAt: startedAt,
          onLexiconMiss: (miss) => {
            deps.metrics.lexiconMiss.inc({ capability: miss.capability, service_id: miss.serviceId });
          },
        }),
      );

      // Async order: one row PER capability, all carrying the same supplier reference, so the
      // worker and the wait window settle every section this one order answers.
      if (routed.outcome.kind === 'pending' && routed.service !== undefined) {
        await deps.repos.orders.insert({
          id: `ord_${randomUUID()}`, // hyphens kept, as for the check id
          checkId,
          tenantId: request.tenantId,
          providerId: routed.service.providerId,
          serviceId: routed.service.serviceId,
          capability,
          // `reference_id` is UNIQUE. The first row keeps the attempt id the supplier was given
          // (the webhook matches on it); the rest are suffixed. An attached order has no attempt.
          referenceId:
            last !== undefined
              ? index === 0
                ? last.attemptId
                : `${last.attemptId}:${capability}`
              : randomUUID(),
          orderReference: routed.outcome.orderReference,
          imeiHash: request.imeiHash,
          status: 'pending',
          attempts: 0,
          nextPollAt: new Date(startedAt.getTime() + FIRST_POLL_MS),
          // An attached order expires when the order it joined does -- it is the same job.
          expiresAt: open?.expiresAt ?? new Date(startedAt.getTime() + ORDER_TTL_MS),
          createdAt: startedAt,
          settledAt: undefined,
        });
      }
    }
  }
}

/** Once per call, not per capability: one call is one purchase. */
function recordAttemptMetrics(deps: RunCheckDeps, routed: CallResult): void {
  for (const attempt of routed.attempts) {
    deps.metrics.providerCall.inc({
      provider_id: attempt.providerId,
      capability: attempt.capability,
      kind: attempt.outcome.kind,
    });
    deps.metrics.providerLatency.observe(
      { provider_id: attempt.providerId, capability: attempt.capability },
      attempt.latencyMs / 1000,
    );
    // Every leg but the last is a failover we swallow. It is real money and it is invisible in
    // revenue, which is exactly why it gets its own counter.
    if (attempt !== routed.attempts[routed.attempts.length - 1] || attempt.outcome.kind === 'failed') {
      deps.metrics.absorbedCostUsd.inc(
        { provider_id: attempt.providerId, reason: 'failover_leg' },
        attempt.costUsd,
      );
    }
  }
  // 100% of provider spend is structurally unrecovered now -- there is no billing to recover any
  // of it -- so the last attempt's cost is always visible here, not just on a failover leg.
  const last = routed.attempts[routed.attempts.length - 1];
  if (last !== undefined && last.costUsd > 0) {
    deps.metrics.absorbedCostUsd.inc({ provider_id: last.providerId, reason: 'no_billing' }, last.costUsd);
  }
}

function firstOf(capabilities: readonly Capability[]): Capability {
  const [first] = capabilities;
  if (first === undefined) throw new Error('a planned call has no capabilities');
  return first;
}

function hasDecidingField(capability: Capability, present: readonly CanonicalField[]): boolean {
  return fieldsFor(capability).some((f) => present.includes(f) && capabilityOf(f) === capability);
}

function offlineIdentity(directory: TacDirectory, imei: Imei, checkedAt: Date): SectionResult {
  const entry = directory.lookup(imei.typeAllocationCode);
  const coverage = identityCoverage(directory);
  return assembleSection({
    capability: 'identity.model',
    checkedAt,
    coverage,
    outcome:
      entry !== undefined
        ? {
            kind: 'answered',
            fields: [
              { field: 'identity.model', value: entry.model },
              { field: 'identity.manufacturer', value: entry.manufacturer },
            ],
            misses: [],
          }
        : {
            kind: 'answered',
            fields: [],
            misses: [],
          },
  });
}

function fromCache(
  capability: Capability,
  hits: Awaited<ReturnType<FieldCache['read']>>,
  deps: RunCheckDeps,
  checkedAt: Date,
): SectionResult {
  const oldest = hits.reduce((a, b) => (a.checkedAt < b.checkedAt ? a : b));
  return assembleSection({
    capability,
    // The ORIGINAL checked_at, not now. Serving a cache hit that looks like a fresh check is the
    // one thing this product cannot do (ADR-0004).
    checkedAt: oldest.checkedAt,
    coverage: hits[0]?.coverage ?? coverageFor(capability, deps.tacDirectory),
    freshness: {
      cached: true,
      age_seconds: Math.max(...hits.map((h) => h.ageSeconds)),
      ttl_seconds: Math.min(...hits.map((h) => h.ttlSeconds)),
    },
    outcome: {
      kind: 'answered',
      fields: hits.map((h) => ({
        field: h.field,
        value: h.value,
        ...(h.rawLabel !== undefined ? { rawLabel: h.rawLabel } : {}),
      })),
      misses: [],
    },
    onLexiconMiss: () => {
      void checkedAt;
    },
  });
}

/** Also rebuilds `summary.reasons` for the GET routes, so a stored report reads the same. */
export function reasonsFor(sections: readonly SectionResult[]): string[] {
  const reasons: string[] = [];
  for (const section of sections) {
    switch (section.outcome) {
      case 'fail':
        if (section.finding !== undefined) reasons.push(section.finding.summary);
        break;
      case 'pass':
        reasons.push(`${label(section.capability)}: nothing found against this device.`);
        break;
      case 'inconclusive':
        reasons.push(`${label(section.capability)}: unresolved (${section.reason ?? 'unknown'}).`);
        break;
      case 'unavailable':
        reasons.push(`${label(section.capability)}: not checked (${section.reason ?? 'unknown'}).`);
        break;
    }
  }
  return reasons;
}

const LABELS: Readonly<Record<Capability, string>> = {
  'identity.model': 'Device identity',
  'blacklist.gsma': 'Block list',
  'lock.carrier': 'Carrier lock',
  'lock.activation': 'Activation lock',
  'lock.mdm': 'Organisation management',
  'warranty.status': 'Warranty',
  'warranty.purchase_date': 'Purchase date',
  'network.sold_by': 'Sales channel',
};

function label(capability: Capability): string {
  return LABELS[capability];
}
