import type { Capability } from '@imei-check/contract';
import type { CanonicalField, FieldValue } from './fields.js';

/**
 * What a provider returns. **Not** the public envelope.
 *
 * ADR-0002: `execute()` yields one of four outcomes and the conversion to a `SectionResult`
 * happens in exactly one file. Letting each adapter emit a `SectionResult` would put the power to
 * say `pass` in fifteen files written against fifteen undocumented supplier formats.
 *
 * The distinction that carries the product:
 * - `answered`  -- the supplier replied and we understood it. May still contain nothing useful.
 * - `pending`   -- a standard (non-express) order; the answer arrives by poll or webhook in hours.
 * - `rejected`  -- the supplier refused this specific request. A real answer about coverage.
 * - `failed`    -- transport, timeout, auth, open circuit. We never got an answer.
 *
 * `failed` is the ONLY outcome that may trigger failover. See `router.ts`.
 */
export type ProviderOutcome =
  | {
      readonly kind: 'answered';
      readonly fields: readonly FieldValue[];
      /** Phrases the lexicon did not recognise. Each one becomes `inconclusive`, never a default. */
      readonly misses: readonly LexiconMiss[];
      readonly providerCostUsd?: number;
      readonly dataAsOf?: Date;
    }
  | {
      readonly kind: 'pending';
      readonly orderReference: string;
      readonly estimatedSeconds?: number;
      readonly providerCostUsd?: number;
    }
  | {
      readonly kind: 'rejected';
      /** The supplier's own refusal category, normalised. */
      readonly reason: RejectionReason;
      readonly detail?: string;
    }
  | {
      readonly kind: 'failed';
      readonly reason: FailureReason;
      readonly detail?: string;
      readonly httpStatus?: number;
    };

/**
 * The supplier answered and said "no, not for this device".
 *
 * These are answers, not faults, and they must not trigger failover: asking a second supplier
 * because the first said "this TAC is not an Apple device" just spends money to be told the same
 * thing.
 */
export type RejectionReason =
  | 'device_not_supported'
  | 'service_not_available_for_device'
  | 'device_not_found'
  | 'duplicate_order'
  | 'invalid_imei';

/** We never obtained an answer. The only class that may fail over. */
export type FailureReason =
  | 'no_provider_configured'
  | 'timeout'
  | 'transport_error'
  | 'http_error'
  | 'auth_error'
  | 'insufficient_provider_balance'
  | 'rate_limited'
  | 'circuit_open'
  | 'malformed_response'
  | 'spend_cap_reached';

export interface LexiconMiss {
  readonly field: CanonicalField;
  /** The unrecognised phrase, scrubbed of IMEI digits. This is what a human needs to add a rule. */
  readonly rawValue: string;
  readonly serviceId: string;
}

/** One purchasable service on one supplier. Comes from checked-in YAML, never from a service name. */
export interface CatalogueService {
  readonly serviceId: string;
  readonly providerId: string;
  /** Seller-authored and useless for routing; kept for operator display only. */
  readonly displayName: string;
  readonly capabilities: readonly Capability[];
  readonly fields: readonly CanonicalField[];
  /**
   * Which lexicon interprets this service's values.
   *
   * Named explicitly rather than defaulting to `serviceId`, because two suppliers' service IDs are
   * their own opaque strings (`"12"`, `apple-gsx`) while a lexicon describes a RESPONSE FORMAT that
   * several services may share. Binding them by coincidence of naming is how a service silently
   * ends up with no lexicon and every value becomes a miss.
   */
  readonly lexiconId: string;
  /** What the supplier charges us, in USD. Drift here silently turns a margin negative. */
  readonly costUsd: number;
  /** What we charge the tenant. */
  readonly credits: number;
  readonly async: boolean;
  readonly timeoutMs: number;
  /** TAC prefixes or `['*']`. A GSX service that claims to cover Samsung is a catalogue bug. */
  readonly appliesToTacPrefixes: readonly string[];
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

export interface ProviderHealth {
  readonly providerId: string;
  readonly circuit: 'closed' | 'open' | 'half_open';
  readonly consecutiveFailures: number;
  readonly openedAt?: Date;
}

export interface ExecuteRequest {
  readonly capability: Capability;
  readonly service: CatalogueService;
  /**
   * The raw digits. This is the ONE place a raw IMEI legitimately exists in a request path --
   * it has to reach the supplier. It is never logged, never persisted and never returned.
   */
  readonly imeiDigits: string;
  readonly signal: AbortSignal;
  /** Where an async supplier should POST its result. */
  readonly feedbackUrl?: string;
  /** Our own id for this attempt, echoed to the supplier so a webhook can be matched back. */
  readonly referenceId: string;
}

export interface WebhookInput {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
}

export interface ParsedWebhook {
  readonly referenceId: string;
  readonly outcome: ProviderOutcome;
}

/**
 * A supplier.
 *
 * Deliberately narrow. Everything policy-shaped -- which provider to try first, whether to charge,
 * how long to cache -- lives outside, because those decisions must be uniform across suppliers and
 * testable without one.
 */
export interface Provider {
  readonly id: string;
  catalogue(): readonly CatalogueService[];
  supports(capability: Capability, tac: string): CatalogueService | undefined;
  execute(request: ExecuteRequest): Promise<ProviderOutcome>;
  /** Async suppliers only: ask again about an order we were told was pending. */
  poll?(orderReference: string, service: CatalogueService, signal: AbortSignal): Promise<ProviderOutcome>;
  /** Async suppliers only: verify and decode an inbound feedback POST. Untrusted input. */
  parseWebhook?(input: WebhookInput): Promise<ParsedWebhook>;
  /** Balance and reachability, for reconciliation and /readyz-adjacent dashboards. */
  health?(signal: AbortSignal): Promise<{ balanceUsd?: number; reachable: boolean }>;
}
