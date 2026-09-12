import type { Coverage } from '@imei-check/contract';
import type { TacDirectory } from '@imei-check/identity';

/**
 * Coverage metadata: what an answer actually covers.
 *
 * Kept in one place because these caveats are the difference between a true statement and a
 * misleading one, and a caveat that lives at the call site gets dropped by the next refactor.
 */

export function identityCoverage(dir: TacDirectory): Coverage {
  return {
    registries: ['tac_directory'],
    region_model: 'vendor_records',
    enforced_in: ['*'],
    source_version: dir.version,
    ...(dir.attribution ? { attribution: dir.attribution } : {}),
    caveats: [
      'A Type Allocation Code identifies the model a number was allocated to, not the handset in ' +
        'front of you. It cannot detect a cloned or re-flashed IMEI.',
    ],
  };
}

/**
 * The caveats on a clean GSMA answer. Invariant 6 refuses to serve a clean blacklist result
 * without them.
 */
export const GSMA_CAVEATS = [
  'A handset reported stolen in the last 24-72 hours may not yet appear on any list.',
  'Networks in some markets do not report to the GSMA IMEI Database; a clean result says nothing ' +
    'about those markets.',
] as const;
