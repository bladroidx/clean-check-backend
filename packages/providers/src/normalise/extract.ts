/**
 * Step 1 of normalisation: turn a supplier blob into `label -> value` pairs.
 *
 * DHRU suppliers return an HTML fragment inside a JSON string field. It is not a document, it is a
 * `<br>`-separated list of `Label: Value` lines with occasional `<b>` tags and the odd table. This
 * extracts pairs and nothing else -- it makes no judgement about what any of them mean, which is
 * the next two steps' job.
 */

const BR = /<br\s*\/?>/gi;
const TAG = /<[^>]*>/g;
const NBSP = /&nbsp;|&#160;/gi;

const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;|&apos;/gi, "'"],
];

/** Digits that could be an IMEI, removed before a raw value is ever retained or logged. */
const IMEI_SHAPED = /(?<!\d)(?<!\d\.)\d{14,}/g;

export function scrub(value: string): string {
  return value.replace(IMEI_SHAPED, '[REDACTED-IMEI]');
}

export interface ExtractedPair {
  readonly label: string;
  readonly value: string;
}

export function decodeEntities(input: string): string {
  let out = input.replace(NBSP, ' ');
  for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Splits a blob into `Label: Value` pairs.
 *
 * Only the FIRST colon splits a line: `Purchase Date: 2023-01-04 10:33` must not lose its time.
 * A line with no colon is discarded rather than guessed at -- a heading is not a fact, and
 * inventing a label for it is how a stray word becomes a field value.
 */
export function extractPairs(blob: string): ExtractedPair[] {
  const text = decodeEntities(blob.replace(BR, '\n').replace(TAG, '\n'));
  const pairs: ExtractedPair[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const colon = trimmed.indexOf(':');
    if (colon <= 0 || colon === trimmed.length - 1) continue;

    const label = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (label.length === 0 || value.length === 0) continue;

    pairs.push({ label, value: scrub(value) });
  }
  return pairs;
}

/**
 * Flattens a JSON object into the same pair shape, so the modern REST transport and the legacy
 * HTML one converge before the lexicon sees either.
 */
export function pairsFromJson(value: unknown, prefix = '', depth = 0): ExtractedPair[] {
  if (depth > 6 || value === null || value === undefined) return [];

  if (typeof value !== 'object') {
    return prefix ? [{ label: prefix, value: scrub(String(value)) }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => pairsFromJson(v, prefix ? `${prefix}.${i}` : String(i), depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    pairsFromJson(v, prefix ? `${prefix}.${k}` : k, depth + 1),
  );
}

/** Label comparison key: case, spacing and punctuation are all supplier styling, not meaning. */
export function labelKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
