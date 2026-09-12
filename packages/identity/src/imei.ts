import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * An IMEI, validated.
 *
 * Ported from `check-this-phone/core/identity/.../Imei.kt`. The behaviour is deliberately
 * identical, down to the mask characters and the hash input format, because both sides are
 * asserted against the same golden vectors in `testdata/imei-vectors.json`. Change one, change
 * both, and regenerate the vectors -- otherwise the two implementations drift silently and the
 * app's local record stops matching the server's.
 */

export const IMEI_LENGTH = 15;
export const TAC_LENGTH = 8;
const MASK_VISIBLE_HEAD = 2;
const MASK_VISIBLE_TAIL = 2;
const MAX_SINGLE_DIGIT = 9;
const TEN = 10;

const DIGIT_RUN = /\d+/g;

/** Anything that is not a digit or one of the characters a number is grouped with. */
const NON_NUMERIC_SEPARATOR = /[^0-9 \-/.]+/;

/**
 * What came back from parsing.
 *
 * A discriminated union rather than a nullable value, because the three ways it can fail need
 * three different sentences: nothing numeric is a retry, the wrong number of digits is a retry,
 * and a failed checksum is a specific "one of the digits is wrong".
 */
export type ImeiParse =
  | { readonly kind: 'valid'; readonly imei: Imei }
  | { readonly kind: 'checksum_failed'; readonly masked: string; readonly expected: number; readonly given: number }
  | { readonly kind: 'wrong_length'; readonly digitsFound: number }
  | { readonly kind: 'nothing_numeric' };

export class Imei {
  private constructor(readonly digits: string) {}

  /** First eight digits: the Type Allocation Code, which identifies the model. */
  get typeAllocationCode(): string {
    return this.digits.slice(0, TAC_LENGTH);
  }

  /** The check digit the number carries. */
  get checkDigit(): number {
    return Number(this.digits[IMEI_LENGTH - 1]);
  }

  /**
   * `35•••••••••••78` -- the default rendering everywhere.
   *
   * A full IMEI on a screen or in a log line is a number a bystander can photograph, and the whole
   * point of a theft check is that it matters who holds it.
   */
  masked(): string {
    const head = this.digits.slice(0, MASK_VISIBLE_HEAD);
    const tail = this.digits.slice(this.digits.length - MASK_VISIBLE_TAIL);
    const hidden = '•'.repeat(this.digits.length - MASK_VISIBLE_HEAD - MASK_VISIBLE_TAIL);
    return `${head}${hidden}${tail}`;
  }

  /**
   * Salted SHA-256 -- **compat only**, kept byte-identical to the Android app so the two agree on
   * a device-local record.
   *
   * Do not use it for server-side cache, dedupe or abuse keys: prefer {@link Imei.hmac}. A plain
   * digest with a salt glued on is fine here but HMAC is the construction actually designed for
   * keyed hashing, and the server is where the whole keyspace is worth attacking.
   *
   * Salted because an unsalted hash of a 15-digit number is not anonymous: the whole space is
   * enumerable in seconds, so the digest would be as identifying as the number.
   */
  saltedHash(salt: string): string {
    if (salt.trim().length === 0) {
      throw new RangeError('An unsalted IMEI hash is reversible by brute force');
    }
    return createHash('sha256').update(`${salt}:${this.digits}`, 'utf8').digest('hex');
  }

  /**
   * Keyed hash for server-side keys (cache, dedupe, abuse accounting).
   *
   * The key must be at least 32 bytes. Short keys are refused rather than accepted-and-weak,
   * for the same reason {@link saltedHash} refuses a blank salt.
   */
  hmac(key: Buffer | string): string {
    const material = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
    if (material.length < 32) {
      throw new RangeError(`IMEI HMAC key must be at least 32 bytes, was ${material.length}`);
    }
    return createHmac('sha256', material).update(this.digits, 'utf8').digest('hex');
  }

  /** Masked, so an accidental interpolation into a log line cannot leak the number. */
  toString(): string {
    return this.masked();
  }

  toJSON(): string {
    return this.masked();
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Imei)) return false;
    const a = Buffer.from(this.digits, 'utf8');
    const b = Buffer.from(other.digits, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Parses whatever the caller supplied.
   *
   * Clipboard content from a dialer dialog arrives with labels, spaces, slashes and sometimes two
   * IMEIs for a dual-SIM phone. The **first** 15-digit run is taken, because that is slot one and
   * it is the number printed on the box.
   */
  static parse(raw: string): ImeiParse {
    const runs = raw.match(DIGIT_RUN) ?? [];
    if (runs.length === 0) return { kind: 'nothing_numeric' };

    // An unbroken run of exactly fifteen digits. Checked first and separately, because simply
    // stripping every non-digit would weld the "1" out of "IMEI (slot 1)" onto the front of the
    // number and then read the wrong fifteen digits with total confidence.
    const unbroken = runs.find((run) => run.length === IMEI_LENGTH);
    if (unbroken !== undefined) return Imei.validate(unbroken);

    // A number written in groups -- "35 310 411 234 567 8" -- where only spaces, dashes, dots or
    // slashes separate the parts. Anything wordier is a separate number.
    const grouped = Imei.groupedCandidates(raw).find((c) => c.length === IMEI_LENGTH);
    if (grouped !== undefined) return Imei.validate(grouped);

    return { kind: 'wrong_length', digitsFound: Math.max(...runs.map((r) => r.length)) };
  }

  private static validate(candidate: string): ImeiParse {
    const expected = Imei.luhnCheckDigit(candidate.slice(0, -1));
    const given = Number(candidate[candidate.length - 1]);
    if (expected === given) return { kind: 'valid', imei: new Imei(candidate) };
    return { kind: 'checksum_failed', masked: new Imei(candidate).masked(), expected, given };
  }

  private static groupedCandidates(raw: string): string[] {
    return raw
      .split(NON_NUMERIC_SEPARATOR)
      .map((chunk) => chunk.replace(/\D/g, ''))
      .filter((chunk) => chunk.length > 0);
  }

  /**
   * The Luhn check digit for the first fourteen digits.
   *
   * Catches a single mistyped digit and most transpositions, which is exactly the error a person
   * makes copying fifteen digits off a screen while someone waits.
   */
  static luhnCheckDigit(body: string): number {
    if (body.length !== IMEI_LENGTH - 1) {
      throw new RangeError(`Luhn body must be ${IMEI_LENGTH - 1} digits, was ${body.length}`);
    }
    if (!/^\d+$/.test(body)) {
      throw new RangeError('Luhn body must be digits only');
    }
    let sum = 0;
    // Doubling runs from the right of the body, which is every second digit from the end.
    for (let index = 0; index < body.length; index += 1) {
      const digit = Number(body[body.length - 1 - index]);
      const contribution = index % 2 === 0 ? digit * 2 : digit;
      sum += contribution > MAX_SINGLE_DIGIT ? contribution - MAX_SINGLE_DIGIT : contribution;
    }
    return (TEN - (sum % TEN)) % TEN;
  }
}
