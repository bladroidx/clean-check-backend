import type { Outcome, Reason, SectionResult } from '@imei-check/contract';
import { cachedPrice } from '../cache/store.js';

/**
 * The charge matrix.
 *
 * What we charge for is a product claim, not an accounting detail. The rules, each with the reason
 * it exists:
 *
 * | Outcome                                     | Charge | Why                                        |
 * |---------------------------------------------|--------|--------------------------------------------|
 * | `pass` / `fail`                             | list   | We answered the question.                  |
 * | `inconclusive(device_not_found_in_registry)`| list   | A real answer: we asked, the registry had  |
 * |                                             |        | nothing. That cost us a supplier call.     |
 * | `inconclusive(awaiting_provider)`           | list   | The order is placed and we have paid for it. |
 * | `inconclusive(unrecognised_provider_value)` | **0**  | Our lexicon is behind. Our bug, not their  |
 * |                                             |        | usage -- charging for it would make format |
 * |                                             |        | drift profitable.                          |
 * | `unavailable` (any reason)                  | **0**  | We did not answer. Never charge for silence. |
 * | cached hit                                  | 20%    | The margin. Still a real answer.            |
 *
 * The two zero rows are the ones that cost money to honour, and they are the ones that make the
 * four-arm contract trustworthy rather than decorative.
 */

export interface ChargeDecision {
  readonly credits: number;
  readonly reason: string;
}

export function chargeFor(args: {
  section: Pick<SectionResult, 'outcome' | 'reason'>;
  listCredits: number;
  cached: boolean;
}): ChargeDecision {
  const { outcome, reason } = args.section;

  if (outcome === 'unavailable') {
    return { credits: 0, reason: 'not_charged_unavailable' };
  }
  if (outcome === 'inconclusive' && reason === 'unrecognised_provider_value') {
    // Our bug. Charging here would mean a supplier reword quietly becomes revenue, which is a
    // direct incentive not to fix the thing that most endangers the product.
    return { credits: 0, reason: 'not_charged_our_lexicon_gap' };
  }
  if (args.cached) {
    return { credits: cachedPrice(args.listCredits), reason: 'charged_cache_hit' };
  }
  return { credits: args.listCredits, reason: 'charged_list' };
}

/** Reasons that mean "we never obtained an answer", restated for the billing path. */
export const NEVER_CHARGED: readonly Reason[] = [
  'provider_timeout',
  'provider_error',
  'circuit_open',
  'provider_not_configured',
  'provider_no_coverage',
  'capability_not_supported_for_device',
  'awaiting_provider_timed_out',
  'insufficient_credits',
  'rate_limited_upstream',
  'not_implemented',
  'cancelled',
  'unrecognised_provider_value',
];

export function isChargeable(outcome: Outcome, reason: Reason | undefined): boolean {
  if (outcome === 'unavailable') return false;
  if (reason !== undefined && NEVER_CHARGED.includes(reason)) return false;
  return true;
}
