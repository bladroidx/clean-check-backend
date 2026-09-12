import { z } from 'zod';
import {
  Capability,
  CheckStatus,
  Outcome,
  Reason,
  RegionModel,
  Remedy,
  Severity,
  Verdict,
} from './enums.js';

/**
 * The wire contract.
 *
 * Mirrors `ProbeResult` / `Evidence` / `Measurement` in
 * `check-this-phone/core/model`, so the Kotlin client deserialises into its own sealed type.
 * That is a hard constraint, not a convenience.
 */

/** One measured fact behind a result. Structured, never pre-formatted into a sentence. */
export const Measurement = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), label: z.string(), value: z.string() }),
  z.object({
    type: z.literal('numeric'),
    label: z.string(),
    value: z.number(),
    unit: z.string().optional(),
  }),
  z.object({ type: z.literal('flag'), label: z.string(), value: z.boolean() }),
  z.object({ type: z.literal('date'), label: z.string(), value: z.string() }),
]);
export type Measurement = z.infer<typeof Measurement>;

/**
 * What an answer actually covers.
 *
 * The feature nobody else ships and the reason this API is worth paying for. Note it never names
 * the upstream provider to the caller -- that is our supply chain, not theirs.
 */
export const Coverage = z.object({
  registries: z.array(z.string()),
  region_model: RegionModel.optional(),
  /** ISO-3166 alpha-2, or `["*"]`. Where the registry is actually enforced. */
  enforced_in: z.array(z.string()).optional(),
  /** Where enforcement is partial, so a clean result says much less. */
  partial_in: z.array(z.string()).optional(),
  /** The provider's own freshness claim, where one is given. */
  data_as_of: z.string().datetime().optional(),
  /** For offline sections: the TAC import behind the answer. */
  source_version: z.string().optional(),
  /** Required where CC-BY-SA data is involved. */
  attribution: z.string().optional(),
  /**
   * The difference between a true statement and a misleading one. Not legal boilerplate:
   * a clean GSMA result cannot see a handset stolen yesterday, or one stolen in a market whose
   * networks do not report.
   */
  caveats: z.array(z.string()).default([]),
});
export type Coverage = z.infer<typeof Coverage>;

export const Finding = z.object({
  key: z.string(),
  severity: Severity,
  summary: z.string(),
  reported_at: z.string().datetime().optional(),
});
export type Finding = z.infer<typeof Finding>;

export const Freshness = z.object({
  cached: z.boolean(),
  age_seconds: z.number().int().nonnegative(),
  ttl_seconds: z.number().int().nonnegative(),
});
export type Freshness = z.infer<typeof Freshness>;

/**
 * One section: exactly one of four arms.
 *
 * The invariants that make the arms mean something are NOT expressible in zod (they are
 * cross-field), so they live in `invariants.ts` and are asserted at runtime and in contract tests.
 * A schema that permits an evidence-free `pass` is not a bug here -- it is why `invariants.ts`
 * exists.
 */
export const SectionResult = z.object({
  capability: Capability,
  outcome: Outcome,
  /** When the DATA was obtained. Never serialisation time. */
  checked_at: z.string().datetime(),
  /** Mandatory on all four arms. On `unavailable` it says what a good answer WOULD have covered. */
  coverage: Coverage,
  evidence: z.array(Measurement).default([]),
  finding: Finding.optional(),
  reason: Reason.optional(),
  remedy: Remedy.optional(),
  /** Human-readable specifics: which provider class, which API, which restriction. */
  detail: z.string().optional(),
  freshness: Freshness,
});
export type SectionResult = z.infer<typeof SectionResult>;

export const Subject = z.object({
  imei_masked: z.string(),
  /** HMAC under the TENANT salt: they can correlate their own records and nobody else's. */
  imei_hash: z.string().optional(),
  tac: z.string().length(8).optional(),
  luhn_valid: z.boolean(),
});
export type Subject = z.infer<typeof Subject>;

export const Summary = z.object({
  verdict: Verdict,
  reasons: z.array(z.string()),
  /** Never silently omitted. A section we could not answer is stated, not dropped. */
  sections_unavailable: z.array(Capability).default([]),
});
export type Summary = z.infer<typeof Summary>;

export const Billing = z.object({
  credits_charged: z.number().int().nonnegative(),
  credits_remaining: z.number().int().nonnegative().optional(),
  breakdown: z
    .array(
      z.object({
        capability: Capability,
        credits: z.number().int().nonnegative(),
        cached: z.boolean(),
      }),
    )
    .default([]),
});
export type Billing = z.infer<typeof Billing>;

export const DISCLAIMER =
  'This report describes registry records at the times stated. Absence of a record is not proof ' +
  'that a device is not stolen.';

export const CheckReport = z.object({
  schema_version: z.string(),
  check_id: z.string(),
  status: CheckStatus,
  subject: Subject,
  requested_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
  sections: z.record(Capability, SectionResult),
  summary: Summary,
  billing: Billing,
  disclaimer: z.string(),
});
export type CheckReport = z.infer<typeof CheckReport>;

/** The free, offline endpoints. No credits, no providers, no IMEI leaves the process. */
export const ValidateRequest = z.object({ imei: z.string().min(1).max(200) });
export type ValidateRequest = z.infer<typeof ValidateRequest>;

export const ValidateResponse = z.object({
  schema_version: z.string(),
  subject: Subject,
  parse: z.object({
    kind: z.enum(['valid', 'checksum_failed', 'wrong_length', 'nothing_numeric']),
    /** One sentence per failure mode -- three different problems need three different sentences. */
    message: z.string(),
    expected_check_digit: z.number().int().min(0).max(9).optional(),
    given_check_digit: z.number().int().min(0).max(9).optional(),
    digits_found: z.number().int().nonnegative().optional(),
  }),
  identity: SectionResult.optional(),
  disclaimer: z.string(),
});
export type ValidateResponse = z.infer<typeof ValidateResponse>;

/**
 * The paid check request.
 *
 * `capabilities` is optional and defaults to everything the device supports, because the common
 * case is "tell me about this phone" and making a caller enumerate our vocabulary to get an answer
 * is a bad first experience. `max_age_seconds: 0` bypasses the cache at full price -- without that
 * escape hatch the freshness promise in `coverage` would be unfalsifiable.
 */
export const CheckRequest = z.object({
  imei: z.string().min(1).max(200),
  capabilities: z.array(Capability).min(1).optional(),
  max_age_seconds: z.number().int().nonnegative().optional(),
  /** Hard ceiling the caller sets on this one check. Never exceeded, even for a partial answer. */
  max_credits: z.number().int().nonnegative().optional(),
});
export type CheckRequest = z.infer<typeof CheckRequest>;

/** What is checkable for a given device, and what it costs, BEFORE committing any credits. */
export const CapabilitiesResponse = z.object({
  schema_version: z.string(),
  subject: Subject,
  capabilities: z.array(
    z.object({
      capability: Capability,
      available: z.boolean(),
      credits: z.number().int().nonnegative(),
      /** Present when `available` is false. Says why, in the same vocabulary as a section. */
      reason: Reason.optional(),
      cached: z.boolean(),
    }),
  ),
  disclaimer: z.string(),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponse>;

export const BalanceResponse = z.object({
  schema_version: z.string(),
  tenant_id: z.string(),
  credits_remaining: z.number().int(),
  recent: z.array(
    z.object({
      delta: z.number().int(),
      reason: z.string(),
      check_id: z.string().nullable(),
      balance_after: z.number().int(),
      created_at: z.string().datetime(),
    }),
  ),
});
export type BalanceResponse = z.infer<typeof BalanceResponse>;

export const WebhookRegistration = z.object({
  url: z.string().url(),
  events: z.array(z.enum(['check.completed'])).default(['check.completed']),
});
export type WebhookRegistration = z.infer<typeof WebhookRegistration>;

export const WebhookRegistered = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  /** Shown once. Sign-verify your side with HMAC-SHA256 over the raw body. */
  secret: z.string(),
});
export type WebhookRegistered = z.infer<typeof WebhookRegistered>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const SCHEMA_VERSION = '1.0';
