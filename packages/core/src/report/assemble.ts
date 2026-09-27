import {
  assertSectionInvariants,
  fail,
  inconclusive,
  pass,
  unavailable,
  type Capability,
  type Coverage,
  type Measurement,
  type SectionResult,
  type Severity,
} from '@imei-check/contract';
import { scrub } from '@imei-check/providers';
import type { CanonicalField, FieldValue, ProviderOutcome } from '@imei-check/providers';

/**
 * The ONE place a `SectionResult` is constructed from a provider outcome.
 *
 * ADR-0002 puts the whole conversion here on purpose. Letting each adapter emit a section would
 * scatter the power to say `pass` across fifteen files written against fifteen undocumented
 * supplier formats; one choke point means arm selection is testable in isolation and no adapter
 * can invent a fifth arm.
 *
 * The rule the whole product rests on, restated because this is where it is enforced:
 *
 *   **A section may only be `pass` on a POSITIVE match against a known-good value.**
 *
 * There is no `else { return pass }` in this file. An unrecognised value is
 * `inconclusive(unrecognised_provider_value)`; a missing field is
 * `inconclusive(device_not_found_in_registry)`; a transport failure is `unavailable`. The day a
 * supplier rewords "Clean" to "No records found", this file returns amber and raises a metric.
 * Without that, it would return green on a stolen handset.
 */

/** The field whose value decides the arm for each capability. */
const DECIDING_FIELD: Readonly<Record<Capability, CanonicalField>> = {
  'identity.model': 'identity.model',
  'blacklist.gsma': 'blacklist.status',
  'lock.carrier': 'lock.carrier.status',
  'lock.activation': 'lock.activation.status',
  'lock.mdm': 'lock.mdm.status',
  'warranty.purchase_date': 'warranty.purchase_date',
  'warranty.status': 'warranty.purchase_date',
  'network.sold_by': 'network.sold_by',
};

interface Polarity {
  /** Values that mean "nothing wrong found". */
  readonly good: readonly string[];
  /** Values that mean "a finding", with how bad it is for a buyer. */
  readonly bad: ReadonlyMap<string, { key: string; severity: Severity; summary: string }>;
}

/**
 * Which canonical value is a `pass` and which is a `fail`, stated explicitly per capability.
 *
 * Explicit because the polarity is not inferable from the word: "clean" means *not blocked* in
 * `blacklist.gsma` and *lock is off* in `lock.activation`, and those are opposite facts about the
 * device wearing the same adjective.
 */
const POLARITY: Readonly<Partial<Record<Capability, Polarity>>> = {
  'blacklist.gsma': {
    good: ['clean'],
    bad: new Map([
      [
        'blocked',
        {
          key: 'blacklisted',
          severity: 'critical' as Severity,
          summary:
            'This IMEI is recorded on a network block list as lost or stolen. It is likely to be ' +
            'refused service, and buying it may mean handling stolen property.',
        },
      ],
    ]),
  },
  'lock.carrier': {
    good: ['unlocked'],
    bad: new Map([
      [
        'locked',
        {
          key: 'carrier_locked',
          severity: 'medium' as Severity,
          summary:
            'The device is locked to a network and will not accept another operator SIM until ' +
            'that operator unlocks it.',
        },
      ],
    ]),
  },
  'lock.activation': {
    good: ['off'],
    bad: new Map([
      [
        'on',
        {
          key: 'activation_locked',
          severity: 'critical' as Severity,
          summary:
            'Activation lock is on. Until the current account holder signs out, the device cannot ' +
            'be set up by anyone else and is unusable after a reset.',
        },
      ],
    ]),
  },
  'lock.mdm': {
    good: ['off'],
    bad: new Map([
      [
        'on',
        {
          key: 'mdm_enrolled',
          severity: 'high' as Severity,
          summary:
            'The device is enrolled with an organisation and will re-apply that management profile ' +
            'after a reset.',
        },
      ],
    ]),
  },
};

/** Fields that are facts rather than judgements: a value is evidence, never a finding. */
const FACTUAL: readonly Capability[] = [
  'identity.model',
  'warranty.purchase_date',
  'network.sold_by',
];

export interface AssembleInput {
  readonly capability: Capability;
  readonly outcome: ProviderOutcome;
  readonly coverage: Coverage;
  readonly checkedAt: Date;
  readonly freshness?: SectionResult['freshness'];
  /** Raised when a recognised label carried an unrecognised value. */
  readonly onLexiconMiss?: (miss: { capability: Capability; serviceId: string }) => void;
}

export function assembleSection(input: AssembleInput): SectionResult {
  const section = redact(build(input));
  // Asserted here rather than only in tests: a guarantee that holds only in CI stops holding the
  // first time someone ships past CI.
  assertSectionInvariants(section);
  return section;
}

/**
 * Last line of defence for the IMEI, applied to everything that leaves this function.
 *
 * `detail` and evidence values are the two caller-facing free-text channels, and both are fed by
 * supplier-authored strings -- a DHRU seller echoing the number back inside
 * `"no record for <the fifteen digits>"` is not hypothetical, it is the common shape of their
 * error messages.
 *
 * The transport already scrubs response bodies at the point of receipt. This scrubs again, at the
 * one place every section is built, because the alternative is trusting fifteen adapters written
 * against fifteen undocumented formats to each remember. The sentinel test found this leak by
 * arriving through an adapter-constructed `detail` that never passed through the transport at all.
 */
function redact(section: SectionResult): SectionResult {
  return {
    ...section,
    ...(section.detail !== undefined ? { detail: scrub(section.detail) } : {}),
    evidence: section.evidence.map((measurement) =>
      measurement.type === 'text'
        ? { ...measurement, label: scrub(measurement.label), value: scrub(measurement.value) }
        : measurement,
    ),
    ...(section.finding !== undefined
      ? { finding: { ...section.finding, summary: scrub(section.finding.summary) } }
      : {}),
  };
}

function build(input: AssembleInput): SectionResult {
  const base = {
    capability: input.capability,
    checkedAt: input.checkedAt,
    coverage: input.coverage,
    ...(input.freshness !== undefined ? { freshness: input.freshness } : {}),
  };

  switch (input.outcome.kind) {
    case 'failed':
      // We never obtained an answer. Never an error to the caller, never silently a pass.
      return unavailable({
        ...base,
        reason: failureReason(input.outcome.reason),
        ...(input.outcome.detail !== undefined ? { detail: input.outcome.detail } : {}),
      });

    case 'rejected':
      // The supplier answered: "not for this device". That is real coverage information, so it is
      // `unavailable` with a reason that says so -- not a failure, and certainly not a pass.
      return unavailable({
        ...base,
        reason:
          input.outcome.reason === 'invalid_imei'
            ? 'capability_not_supported_for_device'
            : input.outcome.reason === 'device_not_supported'
              ? 'capability_not_supported_for_device'
              : 'provider_no_coverage',
        ...(input.outcome.detail !== undefined ? { detail: input.outcome.detail } : {}),
      });

    case 'pending':
      // A standard order: hours, not seconds. The provider HAS engaged with the question, so this
      // is inconclusive rather than unavailable, and the remedy says what to do about it.
      return inconclusive({
        ...base,
        reason: 'awaiting_provider',
        remedy: 'retry_later',
        detail:
          'The supplier accepted the order and will answer shortly. Poll GET /v1/deep_checks/{check_id}.',
      });

    case 'answered':
      return fromAnswer(input, input.outcome.fields, input.outcome.misses);
  }
}

function fromAnswer(
  input: AssembleInput,
  fields: readonly FieldValue[],
  misses: readonly { field: CanonicalField; serviceId: string }[],
): SectionResult {
  const base = {
    capability: input.capability,
    checkedAt: input.checkedAt,
    coverage: input.coverage,
    ...(input.freshness !== undefined ? { freshness: input.freshness } : {}),
  };
  const deciding = DECIDING_FIELD[input.capability];
  const value = fields.find((f) => f.field === deciding);

  // A miss on the DECIDING field is the format-drift signal. It is amber and it is loud.
  const miss = misses.find((m) => m.field === deciding);
  if (value === undefined && miss !== undefined) {
    input.onLexiconMiss?.({ capability: input.capability, serviceId: miss.serviceId });
    return inconclusive({
      ...base,
      reason: 'unrecognised_provider_value',
      remedy: 'retry_later',
      detail:
        'The data source returned a status we do not yet recognise. We will not guess at what it ' +
        'means, so this section is unresolved.',
      evidence: supportingEvidence(fields, deciding),
    });
  }

  // The supplier answered but said nothing about this capability. "We asked and got a non-answer"
  // is inconclusive -- rendering it as a green tick is the exact failure this contract exists for.
  if (value === undefined) {
    return inconclusive({
      ...base,
      reason: 'device_not_found_in_registry',
      remedy: 'try_a_different_capability',
      detail: 'The data source held no record for this device against this check.',
      evidence: supportingEvidence(fields, deciding),
    });
  }

  const evidence = measurements(fields, input.capability);
  if (evidence.length === 0) {
    // Invariant 1 would reject a pass with no evidence; reaching here means the deciding value
    // produced no measurement, which is a bug in `measurements`, not a clean device.
    return inconclusive({
      ...base,
      reason: 'unrecognised_provider_value',
      remedy: 'retry_later',
      detail: 'The data source answered but produced no measurable evidence.',
    });
  }

  const head = evidence[0] as Measurement;
  const rest = evidence.slice(1);

  if (FACTUAL.includes(input.capability)) {
    return pass({ ...base, evidence: [head, ...rest] });
  }

  const polarity = POLARITY[input.capability];
  if (polarity === undefined) {
    return inconclusive({
      ...base,
      reason: 'unrecognised_provider_value',
      remedy: 'retry_later',
      detail: 'No polarity is defined for this capability.',
      evidence,
    });
  }

  const finding = polarity.bad.get(value.value);
  if (finding !== undefined) {
    return fail({ ...base, evidence: [head, ...rest], finding });
  }

  // POSITIVE match only. A value that is neither known-good nor known-bad falls to inconclusive.
  if (polarity.good.includes(value.value)) {
    return pass({ ...base, evidence: [head, ...rest] });
  }

  input.onLexiconMiss?.({ capability: input.capability, serviceId: '(unmapped-value)' });
  return inconclusive({
    ...base,
    reason: 'unrecognised_provider_value',
    remedy: 'retry_later',
    detail: 'The data source returned a status we do not yet recognise.',
    evidence,
  });
}

/** Evidence from fields other than the deciding one, so an inconclusive still shows its working. */
function supportingEvidence(fields: readonly FieldValue[], deciding: CanonicalField): Measurement[] {
  return fields.filter((f) => f.field !== deciding).map(toMeasurement);
}

function measurements(fields: readonly FieldValue[], capability: Capability): Measurement[] {
  const deciding = DECIDING_FIELD[capability];
  const ordered = [...fields].sort((a, b) =>
    a.field === deciding ? -1 : b.field === deciding ? 1 : 0,
  );
  return ordered.map(toMeasurement);
}

const FLAG_FIELDS: Readonly<Partial<Record<CanonicalField, { label: string; trueWhen: string }>>> = {
  'blacklist.status': { label: 'Block-list entry', trueWhen: 'blocked' },
  'lock.carrier.status': { label: 'Locked to a network', trueWhen: 'locked' },
  'lock.activation.status': { label: 'Activation lock', trueWhen: 'on' },
  'lock.mdm.status': { label: 'Managed by an organisation', trueWhen: 'on' },
};

const DATE_FIELDS: ReadonlySet<CanonicalField> = new Set([
  'warranty.purchase_date',
  'blacklist.reported_at',
]);

const TEXT_LABELS: Readonly<Partial<Record<CanonicalField, string>>> = {
  'identity.manufacturer': 'Manufacturer',
  'identity.model': 'Model',
  'blacklist.reported_by': 'Reported by',
  'lock.carrier.network': 'Network',
  'network.sold_by': 'Sold by',
};

/**
 * Structured, never a pre-formatted sentence.
 *
 * A boolean flag renders as a tick or a cross in the Android client; a sentence renders as a
 * sentence in English regardless of the reader's locale.
 */
function toMeasurement(value: FieldValue): Measurement {
  const flag = FLAG_FIELDS[value.field];
  if (flag !== undefined) {
    return { type: 'flag', label: flag.label, value: value.value === flag.trueWhen };
  }
  if (DATE_FIELDS.has(value.field)) {
    return { type: 'date', label: value.field === 'warranty.purchase_date' ? 'Purchase date' : 'Reported on', value: value.value };
  }
  return { type: 'text', label: TEXT_LABELS[value.field] ?? value.rawLabel ?? value.field, value: value.value };
}

function failureReason(
  reason: Extract<ProviderOutcome, { kind: 'failed' }>['reason'],
):
  | 'provider_timeout'
  | 'provider_error'
  | 'circuit_open'
  | 'rate_limited_upstream'
  | 'provider_not_configured'
  | 'spend_cap_reached' {
  switch (reason) {
    case 'timeout':
      return 'provider_timeout';
    case 'circuit_open':
      return 'circuit_open';
    case 'rate_limited':
      return 'rate_limited_upstream';
    case 'no_provider_configured':
    case 'service_disabled':
      // We have no supplier for this capability at all -- or the only one was switched off by the
      // price-drift job. Honest, and actionable by us rather than by the caller.
      return 'provider_not_configured';
    case 'auth_error':
    case 'insufficient_provider_balance':
      // Our account problem, not the caller's. It is still `unavailable` to them -- but the
      // distinct reason is what makes it findable on a dashboard before it becomes an outage.
      return 'provider_not_configured';
    case 'transport_error':
    case 'http_error':
    case 'malformed_response':
      return 'provider_error';
    case 'spend_cap_reached':
      // Our own budget guard, not the supplier and not the caller. Distinct so it pages us.
      return 'spend_cap_reached';
  }
}

/**
 * `warranty.status`, derived from an immutable purchase date plus policy.
 *
 * Never bought and never cached as its own field (ADR-0004): the purchase date is a permanent
 * fact, so deriving the status turns a recurring paid lookup into arithmetic. This is the single
 * largest cost saving in the design.
 */
export function deriveWarrantyStatus(args: {
  purchaseDateIso: string;
  coverage: Coverage;
  checkedAt: Date;
  warrantyMonths?: number;
}): SectionResult {
  const months = args.warrantyMonths ?? 12;
  const purchased = new Date(args.purchaseDateIso);
  const expiry = new Date(purchased);
  expiry.setUTCMonth(expiry.getUTCMonth() + months);
  const inWarranty = args.checkedAt < expiry;

  const evidence: [Measurement, ...Measurement[]] = [
    { type: 'flag', label: 'Within the standard warranty period', value: inWarranty },
    { type: 'date', label: 'Purchase date', value: purchased.toISOString() },
    { type: 'date', label: 'Standard warranty ends', value: expiry.toISOString() },
  ];

  const section = inWarranty
    ? pass({
        capability: 'warranty.status',
        checkedAt: args.checkedAt,
        coverage: args.coverage,
        evidence,
      })
    : // Out of warranty is a fact about an old phone, not a defect in it. `pass` would be wrong
      // (nothing was verified as good) and `fail` would defame a perfectly honest second-hand
      // device, so the honest arm is inconclusive with a remedy.
      inconclusive({
        capability: 'warranty.status',
        checkedAt: args.checkedAt,
        coverage: args.coverage,
        reason: 'device_not_found_in_registry',
        remedy: 'no_action_possible',
        detail:
          'The standard warranty period has elapsed. This says nothing about the condition of ' +
          'the device, only its age.',
        evidence,
      });

  assertSectionInvariants(section);
  return section;
}
