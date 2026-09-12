import type { Capability, Reason, Remedy, Severity } from './enums.js';
import type { Coverage, Measurement, SectionResult } from './envelope.js';

/**
 * Constructors for the four arms.
 *
 * These exist so that no caller assembles a `SectionResult` object literal by hand. Every arm is
 * reachable only through a function that demands what that arm requires -- an `inconclusive`
 * without a remedy is not something you can accidentally type here, it is a compile error.
 */

const NO_FRESHNESS = { cached: false, age_seconds: 0, ttl_seconds: 0 } as const;

interface Base {
  capability: Capability;
  checkedAt: Date;
  coverage: Coverage;
  freshness?: SectionResult['freshness'];
}

export function pass(b: Base & { evidence: [Measurement, ...Measurement[]] }): SectionResult {
  return {
    capability: b.capability,
    outcome: 'pass',
    checked_at: b.checkedAt.toISOString(),
    coverage: b.coverage,
    evidence: b.evidence,
    freshness: b.freshness ?? NO_FRESHNESS,
  };
}

export function fail(
  b: Base & {
    evidence: [Measurement, ...Measurement[]];
    finding: { key: string; severity: Severity; summary: string; reportedAt?: Date };
  },
): SectionResult {
  return {
    capability: b.capability,
    outcome: 'fail',
    checked_at: b.checkedAt.toISOString(),
    coverage: b.coverage,
    evidence: b.evidence,
    finding: {
      key: b.finding.key,
      severity: b.finding.severity,
      summary: b.finding.summary,
      ...(b.finding.reportedAt ? { reported_at: b.finding.reportedAt.toISOString() } : {}),
    },
    freshness: b.freshness ?? NO_FRESHNESS,
  };
}

/**
 * The provider answered, but the answer does not settle the question.
 *
 * `remedy` is required by the type, not merely by a runtime check, because an inconclusive that
 * does not tell the caller what to do is a dead end -- and a dead end reads to a buyer exactly
 * like a failure.
 */
export function inconclusive(
  b: Base & {
    reason: Extract<
      Reason,
      'unrecognised_provider_value' | 'device_not_found_in_registry' | 'awaiting_provider'
    >;
    remedy: Remedy;
    evidence?: Measurement[];
    detail?: string;
  },
): SectionResult {
  return {
    capability: b.capability,
    outcome: 'inconclusive',
    checked_at: b.checkedAt.toISOString(),
    coverage: b.coverage,
    evidence: b.evidence ?? [],
    reason: b.reason,
    remedy: b.remedy,
    ...(b.detail ? { detail: b.detail } : {}),
    freshness: b.freshness ?? NO_FRESHNESS,
  };
}

/**
 * We never obtained an answer.
 *
 * Never an error and never silently a pass. `coverage` is still required: it describes what a
 * successful answer would have covered, which is more honest than null and lets a client explain
 * the gap.
 */
export function unavailable(
  b: Base & {
    reason: Exclude<
      Reason,
      'unrecognised_provider_value' | 'device_not_found_in_registry' | 'awaiting_provider'
    >;
    evidence?: Measurement[];
    detail?: string;
  },
): SectionResult {
  return {
    capability: b.capability,
    outcome: 'unavailable',
    checked_at: b.checkedAt.toISOString(),
    coverage: b.coverage,
    evidence: b.evidence ?? [],
    reason: b.reason,
    ...(b.detail ? { detail: b.detail } : {}),
    freshness: b.freshness ?? NO_FRESHNESS,
  };
}
