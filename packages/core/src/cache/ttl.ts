import type { CanonicalField } from '@imei-check/providers';

/**
 * The TTL table. One file, with the argument beside each value (ADR-0004).
 *
 * Two things make this table the shape it is.
 *
 * **Fields, not responses.** One supplier call yields a purchase date (immutable) and an
 * activation-lock state (flips the moment a seller signs out). Caching the response forces one TTL
 * across five orders of magnitude of volatility, so it is wrong for three of the four facts.
 *
 * **Asymmetry.** Blacklist status is not symmetrically volatile: a clean phone can be reported
 * stolen at any moment, while a blocked one is rarely unblocked. So `clean` expires in an hour and
 * `blocked` lasts a day. A stale "blocked" costs a seller a sale and is recoverable; a stale
 * "clean" helps sell a stolen handset and is not.
 *
 * A TTL of 0 means never cached. `Infinity` means until an import invalidates it.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface TtlRule {
  readonly seconds: number;
  readonly why: string;
}

/**
 * Keyed by field, then by the value where the value changes the answer.
 *
 * `__default` applies when the value is not one of the listed ones.
 */
const TTLS: Readonly<Partial<Record<CanonicalField, Readonly<Record<string, TtlRule>>>>> = {
  'identity.manufacturer': {
    __default: { seconds: Infinity, why: 'A TAC allocation does not change; an import invalidates it.' },
  },
  'identity.model': {
    __default: { seconds: Infinity, why: 'A TAC allocation does not change; an import invalidates it.' },
  },
  'blacklist.status': {
    clean: {
      seconds: HOUR,
      why:
        'A stale clean is the one answer that can cause real harm. Against the inherent 24-72h ' +
        'reporting lag, 60 minutes adds negligible staleness while keeping a re-check after a ' +
        'haggle honest.',
    },
    blocked: {
      seconds: DAY,
      why: 'Blocks are sticky. A stale block is a false alarm, which costs a sale and is recoverable.',
    },
    __default: { seconds: 0, why: 'An unrecognised status is never cached; it is a format-drift signal.' },
  },
  'blacklist.reported_by': {
    __default: { seconds: DAY, why: 'Travels with the block it describes.' },
  },
  'blacklist.reported_at': {
    __default: { seconds: DAY, why: 'Travels with the block it describes.' },
  },
  'lock.carrier.status': {
    __default: {
      seconds: DAY,
      why: 'Unlocks are user-initiated and propagate over hours, not minutes.',
    },
  },
  'lock.carrier.network': {
    __default: { seconds: 7 * DAY, why: 'The selling network does not change.' },
  },
  'lock.activation.status': {
    __default: {
      seconds: 15 * MINUTE,
      why:
        'Flips the instant a seller signs out -- which is exactly what a buyer asks them to do ' +
        'while standing in front of them. A longer TTL would make us wrong at the only moment ' +
        'anyone cares.',
    },
  },
  'lock.mdm.status': {
    __default: { seconds: DAY, why: 'Enrolment changes are administrative and infrequent.' },
  },
  'warranty.purchase_date': {
    __default: { seconds: Infinity, why: 'A historical fact. It cannot change.' },
  },
  'network.sold_by': {
    __default: { seconds: Infinity, why: 'A historical fact. It cannot change.' },
  },
};

const FALLBACK: TtlRule = {
  seconds: 0,
  why: 'No TTL rule is declared for this field, so it is not cached. Never guess a TTL.',
};

export function ttlFor(field: CanonicalField, value: string): TtlRule {
  const table = TTLS[field];
  if (table === undefined) return FALLBACK;
  return table[value] ?? table['__default'] ?? FALLBACK;
}

/** `Infinity` is not a timestamp Postgres will take. Pinned far enough out to mean "until import". */
const FAR_FUTURE_YEARS = 100;

export function expiryFor(field: CanonicalField, value: string, from: Date): Date | undefined {
  const rule = ttlFor(field, value);
  if (rule.seconds === 0) return undefined;
  if (rule.seconds === Infinity) {
    const far = new Date(from);
    far.setUTCFullYear(far.getUTCFullYear() + FAR_FUTURE_YEARS);
    return far;
  }
  return new Date(from.getTime() + rule.seconds * 1000);
}
