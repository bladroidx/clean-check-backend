import { CANONICAL_FIELDS, type CanonicalField } from '../fields.js';
import type { LexiconMiss } from '../types.js';
import { labelKey, type ExtractedPair } from './extract.js';

/**
 * Steps 2 and 3: alias a supplier's label onto a canonical field, then map its value onto a
 * canonical value by POSITIVE match only.
 *
 * This is the line of code the product rests on.
 *
 *   **Absence of the word "blacklisted" is not proof of clean.**
 *
 * A value that no rule recognises yields a MISS, and a miss becomes `inconclusive`. There is no
 * default branch, no `?? 'clean'`, no `!includes('blocked')`. The day a supplier rewords "Clean"
 * to "No records found", the honest failure is an amber answer and a metric; the dishonest one is
 * a green tick on a stolen handset.
 *
 * ## The polarity trap
 *
 * `lock.activation.status` is the field that catches people out. Suppliers express the same fact
 * in opposite polarities:
 *
 *   "Find My iPhone: ON"       -> activation lock is ON   (bad for a buyer)
 *   "FMI Status: Clean"        -> activation lock is OFF  (good for a buyer)
 *   "iCloud Lock: Locked"      -> activation lock is ON
 *
 * "Clean" therefore means OFF here and `clean` in `blacklist.status`, and those are opposite
 * sentiments. So a lexicon is declared per FIELD, and a value rule never carries an implied
 * polarity -- it names the canonical value outright.
 */

export interface ValueRule {
  /** Matched against the normalised value. Exact, after casing and punctuation are flattened. */
  readonly match: string;
  readonly value: string;
}

export interface FieldLexicon {
  readonly field: CanonicalField;
  /** Supplier labels that mean this field. Compared with `labelKey`. */
  readonly labels: readonly string[];
  /** Only for `enum` fields. A `text` or `date` field takes the value as given. */
  readonly values?: readonly ValueRule[];
}

export interface Lexicon {
  readonly providerId: string;
  readonly serviceId: string;
  readonly entries: readonly FieldLexicon[];
}

/** Value comparison key. Suppliers decorate with emoji, asterisks and trailing punctuation. */
export function valueKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[☀-➿\ud83c-􏰀-\udfff]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const US_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;

/**
 * Dates are parsed, never passed through.
 *
 * An unparseable date is a miss like any other. Handing `"Unknown"` downstream as a purchase date
 * would let it be cached forever under an infinite TTL (ADR-0004) -- a wrong fact that never
 * expires is worse than no fact.
 */
export function parseDate(raw: string): string | undefined {
  const iso = ISO_DATE.exec(raw);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const us = US_DATE.exec(raw);
  if (us) {
    const [, m, d, y] = us;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

export interface NormaliseResult {
  readonly values: Map<CanonicalField, { value: string; rawLabel: string }>;
  readonly misses: LexiconMiss[];
}

/**
 * Applies a lexicon to extracted pairs.
 *
 * A label we do not recognise is ignored in silence: suppliers pad responses with marketing lines
 * and a warning per line would bury the one that matters. A label we DO recognise whose value we
 * do not is the loud case -- that is the format drift this whole mechanism exists to detect.
 */
export function normalise(lexicon: Lexicon, pairs: readonly ExtractedPair[]): NormaliseResult {
  const byLabel = new Map<string, FieldLexicon>();
  for (const entry of lexicon.entries) {
    for (const label of entry.labels) byLabel.set(labelKey(label), entry);
  }

  const values = new Map<CanonicalField, { value: string; rawLabel: string }>();
  const misses: LexiconMiss[] = [];

  for (const pair of pairs) {
    const entry = byLabel.get(labelKey(pair.label));
    if (entry === undefined) continue;
    // First recognised occurrence wins: suppliers repeat a field in a summary footer, and the
    // footer is usually the abbreviated one.
    if (values.has(entry.field)) continue;

    const spec = CANONICAL_FIELDS[entry.field];
    const resolved = resolveValue(spec.kind, entry, pair.value);

    // A KNOWN absence is not drift. "Blacklist Records: None" on a clean device, or
    // "Purchase Date: N/A" on a device with no record, is the supplier working correctly -- and
    // raising a lexicon miss for it would fire the format-drift alarm on every clean handset,
    // which is how an alarm gets muted and stops catching the thing it exists for.
    if (resolved.kind === 'absent') continue;

    if (resolved.kind === 'unrecognised') {
      misses.push({ field: entry.field, rawValue: pair.value, serviceId: lexicon.serviceId });
      continue;
    }
    values.set(entry.field, { value: resolved.value, rawLabel: pair.label });
  }

  return { values, misses };
}

/**
 * Three outcomes, not two.
 *
 * The distinction between *absent* and *unrecognised* is the difference between an alarm that
 * means something and one that fires on every request:
 *
 * - `absent`       -- the supplier said, in a way we recognise, that they have nothing. Silent.
 * - `unrecognised` -- the supplier said something we do not understand. Loud, and never charged.
 * - `value`        -- a positive match.
 *
 * Note the asymmetry: a placeholder in a `text` or `date` field is an absence, but an enum value
 * we cannot match is ALWAYS unrecognised, placeholder or not. Enum fields are the deciding fields
 * -- the ones that choose the arm -- so on those the safe direction is to be loud, and softening
 * them is exactly how "Status: Unknown" would quietly stop being visible.
 */
type Resolved = { kind: 'value'; value: string } | { kind: 'absent' } | { kind: 'unrecognised' };

function resolveValue(
  kind: 'text' | 'enum' | 'date' | 'flag',
  entry: FieldLexicon,
  raw: string,
): Resolved {
  switch (kind) {
    case 'enum':
    case 'flag': {
      const key = valueKey(raw);
      // Positive match only. There is deliberately no benign fallback arm in this switch.
      const rule = entry.values?.find((r) => valueKey(r.match) === key);
      return rule === undefined ? { kind: 'unrecognised' } : { kind: 'value', value: rule.value };
    }
    case 'date': {
      const trimmed = raw.trim();
      if (trimmed.length === 0 || isPlaceholder(trimmed)) return { kind: 'absent' };
      const parsed = parseDate(trimmed);
      // A date we cannot parse IS drift: passing it through would let an uninterpretable string be
      // cached under an infinite TTL, and a wrong fact that never expires is worse than no fact.
      return parsed === undefined ? { kind: 'unrecognised' } : { kind: 'value', value: parsed };
    }
    case 'text': {
      const trimmed = raw.trim();
      // A supplier's placeholder for "we have nothing" is not a model name. Treating "N/A" as text
      // would put it in the evidence list as though it were a fact.
      if (trimmed.length === 0 || isPlaceholder(trimmed)) return { kind: 'absent' };
      return { kind: 'value', value: trimmed };
    }
  }
}

const PLACEHOLDERS = new Set([
  'n a',
  'na',
  'unknown',
  'none',
  'null',
  'nil',
  'not available',
  'not found',
  'no data',
  'pending',
  '',
]);

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(valueKey(value));
}
