import type { CanonicalField, FieldValue } from '../fields.js';

/**
 * Narrows a normalised value map to the fields the catalogue says this service sells.
 *
 * A supplier that volunteers `lock.activation.status` on a blacklist-only service is not a bonus,
 * it is an unpaid claim we would then cache and serve as though we had bought it. The catalogue is
 * the contract; anything outside it is dropped.
 */
export function fieldValues(
  values: ReadonlyMap<CanonicalField, { value: string; rawLabel: string }>,
  declared: readonly CanonicalField[],
): FieldValue[] {
  const out: FieldValue[] = [];
  for (const field of declared) {
    const found = values.get(field);
    if (found === undefined) continue;
    out.push({ field, value: found.value, rawLabel: found.rawLabel });
  }
  return out;
}
