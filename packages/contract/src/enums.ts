import { z } from 'zod';

/**
 * Closed vocabularies. Adding an arm to any of these is a BREAKING change: the Android client's
 * `when` over the Kotlin sealed types is exhaustive and fails closed on an unknown value.
 * See `.claude/skills/api-versioning/SKILL.md`.
 */

/** The four arms. All four are real answers. */
export const Outcome = z.enum(['pass', 'fail', 'inconclusive', 'unavailable']);
export type Outcome = z.infer<typeof Outcome>;

export const Capability = z.enum([
  'identity.model',
  'blacklist.gsma',
  'lock.carrier',
  'lock.activation',
  'lock.mdm',
  'warranty.status',
  'warranty.purchase_date',
  'network.sold_by',
]);
export type Capability = z.infer<typeof Capability>;

/**
 * Why a section is not `pass`/`fail`.
 *
 * The boundary that matters: **"we asked and got a non-answer" is inconclusive; "we never got an
 * answer" is unavailable.** Getting it backwards renders "not in the registry" as a green tick.
 */
export const Reason = z.enum([
  // -- inconclusive: the provider answered, but the answer does not settle the question
  'unrecognised_provider_value',
  'device_not_found_in_registry',
  'awaiting_provider',
  // -- unavailable: we never obtained an answer
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
  'requires_deep_check',
  'spend_cap_reached',
  'cancelled',
]);
export type Reason = z.infer<typeof Reason>;

/** Reasons that mean "the provider answered". Used to decide the arm and whether to charge. */
export const INCONCLUSIVE_REASONS = [
  'unrecognised_provider_value',
  'device_not_found_in_registry',
  'awaiting_provider',
] as const satisfies readonly Reason[];

/**
 * What the caller can do about an `inconclusive`.
 *
 * Mandatory on that arm: an inconclusive that does not say what to do is a dead end, and a dead
 * end reads to a buyer exactly like a failure.
 */
export const Remedy = z.enum([
  'retry_later',
  'retry_without_cache',
  'top_up_credits',
  'supply_serial_number',
  'contact_carrier_directly',
  'try_a_different_capability',
  'no_action_possible',
]);
export type Remedy = z.infer<typeof Remedy>;

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;

export const CheckStatus = z.enum(['pending', 'partial', 'complete', 'expired']);
export type CheckStatus = z.infer<typeof CheckStatus>;

/**
 * Deliberately not a boolean. A wrong `clean: true` either facilitates the sale of stolen goods or
 * defames a seller, and `undetermined` must be loud rather than absent.
 */
export const Verdict = z.enum(['green', 'amber', 'red', 'undetermined']);
export type Verdict = z.infer<typeof Verdict>;

/** How far a registry's coverage actually extends. Named, because "global" is usually a lie. */
export const RegionModel = z.enum(['reporting_networks', 'national_ceir', 'vendor_records']);
export type RegionModel = z.infer<typeof RegionModel>;
