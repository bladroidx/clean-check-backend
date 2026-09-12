import type { Capability } from '@imei-check/contract';

/**
 * The canonical field vocabulary.
 *
 * Providers speak fifteen dialects; everything downstream speaks this. A normaliser's only job is
 * to turn a supplier blob into a subset of these, and the cache is keyed on them individually
 * (ADR-0004) -- which is the whole reason fields exist as a concept separate from capabilities.
 * One GSX call yields `warranty.purchase_date` (immutable) and `lock.activation.status` (flips the
 * moment a seller signs out); caching those under one key is wrong for one of them.
 */

export const CANONICAL_FIELDS = {
  'identity.manufacturer': { kind: 'text', capability: 'identity.model' },
  'identity.model': { kind: 'text', capability: 'identity.model' },
  'blacklist.status': { kind: 'enum', capability: 'blacklist.gsma', values: ['clean', 'blocked'] },
  'blacklist.reported_by': { kind: 'text', capability: 'blacklist.gsma' },
  'blacklist.reported_at': { kind: 'date', capability: 'blacklist.gsma' },
  'lock.carrier.status': { kind: 'enum', capability: 'lock.carrier', values: ['locked', 'unlocked'] },
  'lock.carrier.network': { kind: 'text', capability: 'lock.carrier' },
  'lock.activation.status': { kind: 'enum', capability: 'lock.activation', values: ['on', 'off'] },
  'lock.mdm.status': { kind: 'enum', capability: 'lock.mdm', values: ['on', 'off'] },
  'warranty.purchase_date': { kind: 'date', capability: 'warranty.purchase_date' },
  'network.sold_by': { kind: 'text', capability: 'network.sold_by' },
} as const satisfies Record<string, { kind: FieldKind; capability: Capability; values?: readonly string[] }>;

export type FieldKind = 'text' | 'enum' | 'date' | 'flag';
export type CanonicalField = keyof typeof CANONICAL_FIELDS;

export const ALL_FIELDS = Object.keys(CANONICAL_FIELDS) as CanonicalField[];

export function fieldsFor(capability: Capability): CanonicalField[] {
  return ALL_FIELDS.filter((f) => CANONICAL_FIELDS[f].capability === capability);
}

export function capabilityOf(field: CanonicalField): Capability {
  return CANONICAL_FIELDS[field].capability;
}

/**
 * A normalised value plus the raw text it came from.
 *
 * The raw text is retained because a lexicon miss is only diagnosable if you can see the phrase
 * that missed -- but it is scrubbed of IMEI digits at the point of capture, never later.
 */
export interface FieldValue {
  readonly field: CanonicalField;
  readonly value: string;
  /** The supplier's own wording, scrubbed. Evidence for the caller and a debugging aid for us. */
  readonly rawLabel?: string;
}

/** `warranty.status` is DERIVED from `warranty.purchase_date`, never cached and never bought. */
export const DERIVED_CAPABILITIES: readonly Capability[] = ['warranty.status'];
