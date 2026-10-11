import type { FieldValue } from '@imei-check/providers';
import type { TacObservation, TacRepo } from '../db/types.js';

/**
 * Harvests a `(TAC -> device)` fact from a paid answer (ADR-0005, "harvest our own").
 *
 * A supplier answer that names the device is ours outright, with no licence attached, so it outranks
 * every imported directory row. Over time the free tier names exactly the phones people check. Both
 * names are required: a manufacturer without a model (or the reverse) would teach the free tier half
 * a device.
 */
export function observationOf(
  tac: string | undefined,
  fields: readonly FieldValue[],
  seenAt: Date,
): TacObservation | undefined {
  if (tac === undefined || !/^\d{8}$/.test(tac)) return undefined;
  const manufacturer = fields.find((f) => f.field === 'identity.manufacturer')?.value.trim();
  const model = fields.find((f) => f.field === 'identity.model')?.value.trim();
  if (!manufacturer || !model) return undefined;
  return { tac, manufacturer, model, seenAt };
}

/**
 * Stores the observation, if the answer has one, and hands it to [onLearned] so a running process can
 * answer the TAC at once instead of waiting for its next reload from the database.
 */
export async function harvestTac(
  repo: TacRepo,
  tac: string | undefined,
  fields: readonly FieldValue[],
  seenAt: Date,
  onLearned?: (observation: TacObservation) => void,
): Promise<void> {
  const observation = observationOf(tac, fields, seenAt);
  if (observation === undefined) return;
  await repo.recordObservation(observation);
  onLearned?.(observation);
}
