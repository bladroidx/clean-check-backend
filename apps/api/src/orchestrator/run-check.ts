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
  type CanonicalField,
  type FieldValue,
  type Router,
} from '@imei-check/providers';
import type { FieldCache } from '@imei-check/core';
import type { Metrics } from '@imei-check/core';
import type { CreditRepo, Repositories, RestrictionLevel } from '@imei-check/core';
import { assembleSection, deriveWarrantyStatus } from '@imei-check/core';
import { coverageFor } from '@imei-check/core';
import { chargeFor } from '@imei-check/core';
import { identityCoverage } from '@imei-check/core';

/**
 * One check, end to end.
 *
 * The ordering here is load-bearing and each step is placed where it is for a reason that costs
 * money or credibility if moved:
 *
 * 1. **Free capabilities first.** `identity.model` is answered from the in-process TAC directory.
 *    Buying it from a supplier when we already know the answer is pure waste.
 * 2. **Cache before credits.** A cached capability costs 20% of list, so the reserve has to know
 *    what is cached before it decides how much to hold.
 * 3. **Reserve before providers.** A check that dies halfway must not leave the tenant unbilled
 *    for calls we have already paid for.
 * 4. **Settle after.** We refund the difference between reserved and actually chargeable, because
 *    the charge matrix cannot be evaluated until the arms are known.
 *
 * Partial affordability is honoured rather than rejected: a tenant who can afford two of three
 * capabilities gets two answers and `unavailable(insufficient_credits)` for the third. A 402 that
 * kills the whole check throws away answers we could have given and already paid nothing for.
 */

export interface RunCheckDeps {
  readonly repos: Repositories;
  readonly router: Router;
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
  readonly restriction: RestrictionLevel;
  readonly signal: AbortSignal;
}

/** Answered from the in-process directory. Free, offline, and always tried before a supplier. */
const OFFLINE_CAPABILITIES: readonly Capability[] = ['identity.model'];

/** Computed from other fields. Never bought, never cached (ADR-0004). */
const DERIVED_CAPABILITIES: readonly Capability[] = ['warranty.status'];

export async function runCheck(deps: RunCheckDeps, request: RunCheckRequest): Promise<CheckReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const checkId = `chk_${randomUUID().replaceAll('-', '')}`;
  const tac = request.imei.typeAllocationCode;

  await deps.repos.checks.insert({
    id: checkId,
    tenantId: request.tenantId,
    imeiHash: request.imeiHash,
    subjectHash: request.imei.hmac(Buffer.from(request.tenantSalt, 'utf8')),
    imeiMasked: request.imei.masked(),
    tac,
    requestedCapabilities: request.capabilities,
    status: 'pending',
    idempotencyKey: request.idempotencyKey,
    creditsCharged: 0,
    verdict: undefined,
    createdAt: startedAt,
    completedAt: undefined,
  });

  const sections = new Map<Capability, SectionResult>();
  const breakdown: Array<{ capability: Capability; credits: number; cached: boolean }> = [];
  /** Fields resolved during this run, so a derived capability can read them without re-buying. */
  const resolvedFields = new Map<CanonicalField, FieldValue>();

  // ---- 1. Offline capabilities. Free.
  for (const capability of request.capabilities) {
    if (!OFFLINE_CAPABILITIES.includes(capability)) continue;
    const section = offlineIdentity(deps.tacDirectory, request.imei, startedAt);
    sections.set(capability, section);
    breakdown.push({ capability, credits: 0, cached: false });
    deps.metrics.sectionOutcome.inc({
      capability,
      outcome: section.outcome,
      reason: section.reason ?? 'none',
    });
    const entry = deps.tacDirectory.lookup(tac);
    if (entry !== undefined) {
      resolvedFields.set('identity.model', { field: 'identity.model', value: entry.model });
      resolvedFields.set('identity.manufacturer', {
        field: 'identity.manufacturer',
        value: entry.manufacturer,
      });
    }
  }

  // ---- 2. What remains is paid. Read the cache first: it changes the price.
  const paid = request.capabilities.filter(
    (c) => !OFFLINE_CAPABILITIES.includes(c) && !DERIVED_CAPABILITIES.includes(c),
  );

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

  // ---- 3. Price and reserve.
  const quote = paid.map((capability) => {
    const isCached = cached.has(capability);
    const list = listPriceFor(deps, capability, tac);
    const decision = chargeFor({
      section: { outcome: 'pass', reason: undefined },
      listCredits: list,
      cached: isCached,
    });
    return { capability, credits: decision.credits, cached: isCached, list };
  });

  const affordable = await reserveWhatWeCan({
    credits: deps.repos.credits,
    tenantId: request.tenantId,
    checkId,
    quote,
    idempotencyKey: request.idempotencyKey ?? checkId,
    // `no_paid` and `cache_only` stop spend without stopping the service. That is what makes a
    // false positive on the abuse ladder cheap for everyone.
    allowPaid: request.restriction !== 'no_paid' && request.restriction !== 'suspended',
    allowUncached: request.restriction !== 'cache_only',
  });

  let reserved = affordable.reservedCredits;

  // ---- 4. Resolve each paid capability.
  for (const item of quote) {
    const { capability } = item;

    if (!affordable.granted.has(capability)) {
      const section = unavailable({
        capability,
        checkedAt: startedAt,
        coverage: coverageFor(capability, deps.tacDirectory),
        reason: affordable.reasonFor(capability),
        detail: affordable.detailFor(capability),
      });
      sections.set(capability, section);
      deps.metrics.sectionOutcome.inc({ capability, outcome: 'unavailable', reason: section.reason ?? 'none' });
      continue;
    }

    const hits = cached.get(capability);
    if (hits !== undefined && hits.length > 0) {
      const section = fromCache(capability, hits, deps, startedAt);
      sections.set(capability, section);
      for (const hit of hits) {
        resolvedFields.set(hit.field, { field: hit.field, value: hit.value, ...(hit.rawLabel !== undefined ? { rawLabel: hit.rawLabel } : {}) });
      }
      breakdown.push({ capability, credits: item.credits, cached: true });
      deps.metrics.sectionOutcome.inc({
        capability,
        outcome: section.outcome,
        reason: section.reason ?? 'none',
      });
      deps.metrics.creditsCharged.inc({ reason: 'charged_cache_hit' }, item.credits);
      continue;
    }

    const routed = await deps.router.run({
      capability,
      tac,
      imeiDigits: request.imei.digits,
      signal: request.signal,
    });

    for (const attempt of routed.attempts) {
      deps.metrics.providerCall.inc({
        provider_id: attempt.providerId,
        capability,
        kind: attempt.outcome.kind,
      });
      deps.metrics.providerLatency.observe(
        { provider_id: attempt.providerId, capability },
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

    const section = assembleSection({
      capability,
      outcome: routed.outcome,
      coverage: coverageFor(capability, deps.tacDirectory),
      checkedAt: startedAt,
      onLexiconMiss: (miss) => {
        deps.metrics.lexiconMiss.inc({ capability: miss.capability, service_id: miss.serviceId });
      },
    });
    sections.set(capability, section);
    deps.metrics.sectionOutcome.inc({
      capability,
      outcome: section.outcome,
      reason: section.reason ?? 'none',
    });

    // Cache and remember whatever we actually learned, even from a section that did not pass.
    if (routed.outcome.kind === 'answered') {
      for (const field of routed.outcome.fields) resolvedFields.set(field.field, field);
      await deps.cache.write({
        imeiHash: request.imeiHash,
        fields: routed.outcome.fields,
        coverage: coverageFor(capability, deps.tacDirectory),
        providerId: routed.attempts[routed.attempts.length - 1]?.providerId ?? 'unknown',
        checkedAt: startedAt,
      });
    }

    // Async order: record it so the worker can finish the job hours from now.
    if (routed.outcome.kind === 'pending' && routed.service !== undefined) {
      const attempt = routed.attempts[routed.attempts.length - 1];
      await deps.repos.orders.insert({
        id: `ord_${randomUUID().replaceAll('-', '')}`,
        checkId,
        tenantId: request.tenantId,
        providerId: routed.service.providerId,
        serviceId: routed.service.serviceId,
        capability,
        referenceId: attempt?.attemptId ?? randomUUID(),
        orderReference: routed.outcome.orderReference,
        status: 'pending',
        attempts: 0,
        nextPollAt: new Date(startedAt.getTime() + 5 * 60 * 1000),
        expiresAt: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000),
        createdAt: startedAt,
        settledAt: undefined,
      });
    }

    const charge = chargeFor({ section, listCredits: item.list, cached: false });
    breakdown.push({ capability, credits: charge.credits, cached: false });
    deps.metrics.creditsCharged.inc({ reason: charge.reason }, charge.credits);
    if (charge.credits === 0 && routed.attempts.some((a) => a.costUsd > 0)) {
      const last = routed.attempts[routed.attempts.length - 1];
      deps.metrics.absorbedCostUsd.inc(
        { provider_id: last?.providerId ?? 'unknown', reason: charge.reason },
        last?.costUsd ?? 0,
      );
    }
  }

  // ---- 5. Derived capabilities. Free arithmetic over facts we already hold.
  for (const capability of request.capabilities) {
    if (!DERIVED_CAPABILITIES.includes(capability)) continue;
    const purchase = resolvedFields.get('warranty.purchase_date');
    const coverage = coverageFor(capability, deps.tacDirectory);
    const section =
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
          });
    sections.set(capability, section);
    breakdown.push({ capability, credits: 0, cached: false });
    deps.metrics.sectionOutcome.inc({
      capability,
      outcome: section.outcome,
      reason: section.reason ?? 'none',
    });
  }

  // ---- 6. Settle. Refund reserved-minus-actual as a new positive ledger row.
  const chargedTotal = breakdown.reduce((sum, b) => sum + b.credits, 0);
  if (reserved > chargedTotal) {
    await deps.repos.credits.refund({
      tenantId: request.tenantId,
      credits: reserved - chargedTotal,
      checkId,
      reason: 'settle_refund',
      idempotencyKey: `settle:${checkId}`,
    });
    reserved = chargedTotal;
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
    billing: {
      credits_charged: chargedTotal,
      credits_remaining: await deps.repos.credits.balance(request.tenantId),
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
    creditsCharged: chargedTotal,
    completedAt: anyPending ? undefined : completedAt,
  });

  return report;
}

function hasDecidingField(capability: Capability, present: readonly CanonicalField[]): boolean {
  return fieldsFor(capability).some((f) => present.includes(f) && capabilityOf(f) === capability);
}

function listPriceFor(deps: RunCheckDeps, capability: Capability, tac: string): number {
  const candidates = deps.router.candidates(capability, tac);
  // Cheapest first, matching the order the router will actually try them in.
  return candidates[0]?.service.credits ?? 0;
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

function reasonsFor(sections: readonly SectionResult[]): string[] {
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

interface Granted {
  readonly granted: ReadonlySet<Capability>;
  readonly reservedCredits: number;
  reasonFor(capability: Capability): 'insufficient_credits' | 'rate_limited_upstream';
  detailFor(capability: Capability): string;
}

/**
 * Reserves what the balance covers, in requested order, and reports what it could not.
 *
 * Cheapest-first would maximise the number of answers, but it would also silently reorder the
 * caller's priorities -- someone who asks for blacklist first wants blacklist first, and running
 * out of credit is not a reason to give them something else instead.
 */
async function reserveWhatWeCan(args: {
  credits: CreditRepo;
  tenantId: string;
  checkId: string;
  quote: ReadonlyArray<{ capability: Capability; credits: number; cached: boolean }>;
  idempotencyKey: string;
  allowPaid: boolean;
  allowUncached: boolean;
}): Promise<Granted> {
  const granted = new Set<Capability>();
  const blocked = new Map<Capability, 'insufficient_credits' | 'rate_limited_upstream'>();
  let toReserve = 0;

  let balance = await args.credits.balance(args.tenantId);

  for (const item of args.quote) {
    if (!args.allowPaid && item.credits > 0) {
      blocked.set(item.capability, 'rate_limited_upstream');
      continue;
    }
    if (!args.allowUncached && !item.cached) {
      blocked.set(item.capability, 'rate_limited_upstream');
      continue;
    }
    if (item.credits > balance) {
      blocked.set(item.capability, 'insufficient_credits');
      continue;
    }
    balance -= item.credits;
    toReserve += item.credits;
    granted.add(item.capability);
  }

  if (toReserve > 0) {
    const result = await args.credits.reserve({
      tenantId: args.tenantId,
      credits: toReserve,
      checkId: args.checkId,
      idempotencyKey: `reserve:${args.idempotencyKey}`,
    });
    if (!result.ok) {
      // Lost a race against a concurrent check. Every paid capability becomes unavailable, and
      // nothing is charged -- the honest outcome, and it costs us nothing because no supplier has
      // been called yet.
      for (const item of args.quote) {
        granted.delete(item.capability);
        blocked.set(item.capability, 'insufficient_credits');
      }
      toReserve = 0;
    }
  }

  return {
    granted,
    reservedCredits: toReserve,
    reasonFor: (capability) => blocked.get(capability) ?? 'insufficient_credits',
    detailFor: (capability) =>
      blocked.get(capability) === 'rate_limited_upstream'
        ? 'Paid lookups are temporarily restricted on this account. Cached answers are still served.'
        : 'Your credit balance did not cover this capability. The capabilities it did cover were run.',
  };
}
