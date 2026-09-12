import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Imei, IMEI_LENGTH, TAC_LENGTH, type ImeiParse } from '../src/imei.js';

/**
 * Every case in `check-this-phone/core/identity/.../ImeiTest.kt`, ported 1:1, plus the shared
 * golden vectors. Two hand-written ports of the same algorithm drift silently; the vector file is
 * the only thing that notices.
 */

const validBody = '35310411234567';
const valid = validBody + Imei.luhnCheckDigit(validBody);

const expectValid = (parsed: ImeiParse): Imei => {
  expect(parsed.kind).toBe('valid');
  if (parsed.kind !== 'valid') throw new Error('unreachable');
  return parsed.imei;
};

describe('Imei.parse', () => {
  it('accepts a Luhn-valid number', () => {
    expect(Imei.parse(valid).kind).toBe('valid');
  });

  it('rejects a single mistyped digit', () => {
    // The error a person actually makes copying fifteen digits off a screen while someone waits.
    const wrong = valid.slice(0, 5) + ((Number(valid[5]) + 1) % 10) + valid.slice(6);
    const parsed = Imei.parse(wrong);

    expect(parsed.kind).toBe('checksum_failed');
    if (parsed.kind !== 'checksum_failed') throw new Error('unreachable');
    expect(parsed.expected).not.toBe(parsed.given);
  });

  it('rejects a transposition of adjacent digits', () => {
    // Luhn catches most, though not all, transpositions. This pair differs, so it must be caught.
    if (valid[3] === valid[4]) return;
    const transposed = valid.slice(0, 3) + valid[4] + valid[3] + valid.slice(5);
    expect(Imei.parse(transposed).kind).toBe('checksum_failed');
  });

  it('pulls the number out of whatever the dialer put on the clipboard', () => {
    const clipboard = `IMEI (slot 1): ${valid}\nIMEI (slot 2): 356920051234564`;
    // Slot one, which is the number printed on the box.
    expect(expectValid(Imei.parse(clipboard)).digits).toBe(valid);
  });

  it('does not weld a label digit onto the front of the number', () => {
    // The trap the two-stage parse exists for: stripping every non-digit from "slot 1" first
    // produces "1" + the real number, and reads the wrong fifteen digits with total confidence.
    expect(expectValid(Imei.parse(`IMEI (slot 1): ${valid}`)).digits).toBe(valid);
  });

  it('tolerates spaces slashes and dashes', () => {
    const spaced = (valid.match(/.{1,3}/g) ?? []).join(' - ');
    expect(Imei.parse(spaced).kind).toBe('valid');
    expect(Imei.parse((valid.match(/.{1,5}/g) ?? []).join('/')).kind).toBe('valid');
  });

  it('reports nothing numeric distinctly from the wrong number of digits', () => {
    expect(Imei.parse('no digits here')).toEqual({ kind: 'nothing_numeric' });

    const short = Imei.parse('12345');
    expect(short.kind).toBe('wrong_length');
    if (short.kind !== 'wrong_length') throw new Error('unreachable');
    expect(short.digitsFound).toBe(5);
  });

  it('an empty clipboard is nothing numeric, not a checksum failure', () => {
    expect(Imei.parse('')).toEqual({ kind: 'nothing_numeric' });
  });

  it('exposes the type allocation code', () => {
    const imei = expectValid(Imei.parse(valid));
    expect(imei.typeAllocationCode).toBe('35310411');
    expect(imei.typeAllocationCode).toHaveLength(TAC_LENGTH);
  });

  it('exposes the check digit it carries', () => {
    const imei = expectValid(Imei.parse(valid));
    expect(imei.checkDigit).toBe(Number(valid[14]));
    expect(imei.checkDigit).toBe(Imei.luhnCheckDigit(validBody));
  });

  it('equality rejects a different number and a non-Imei', () => {
    const imei = expectValid(Imei.parse(valid));
    const other = expectValid(Imei.parse('356920051234564'));
    expect(imei.equals(other)).toBe(false);
    expect(imei.equals('353104112345676')).toBe(false);
    expect(imei.equals(null)).toBe(false);
  });

  it('two parses of the same number are equal', () => {
    const first = expectValid(Imei.parse(valid));
    const second = expectValid(Imei.parse(`IMEI ${valid}`));
    expect(first.equals(second)).toBe(true);
    expect(first.digits).toBe(second.digits);
  });
});

describe('masking', () => {
  it('masks all but the first and last two digits', () => {
    const masked = expectValid(Imei.parse(valid)).masked();
    expect(masked).toHaveLength(IMEI_LENGTH);
    expect(masked.startsWith(valid.slice(0, 2))).toBe(true);
    expect(masked.endsWith(valid.slice(-2))).toBe(true);
    expect(masked).not.toContain(valid.slice(4, 10));
  });

  it('renders masked by default, so it cannot be logged in full by accident', () => {
    const imei = expectValid(Imei.parse(valid));
    expect(imei.toString()).toBe(imei.masked());
    expect(imei.toString()).not.toContain(valid);
    expect(`${imei}`).not.toContain(valid);
    expect(JSON.stringify({ imei })).not.toContain(valid);
  });
});

describe('hashing', () => {
  it('the salted hash is stable and depends on the salt', () => {
    const imei = expectValid(Imei.parse(valid));
    expect(imei.saltedHash('pepper')).toBe(imei.saltedHash('pepper'));
    expect(imei.saltedHash('pepper')).not.toBe(imei.saltedHash('other'));
    expect(imei.saltedHash('pepper')).not.toContain(valid);
  });

  it('refuses to hash without a salt', () => {
    // An unsalted digest of a 15-digit number is enumerable in seconds, so it is not anonymous.
    const imei = expectValid(Imei.parse(valid));
    expect(() => imei.saltedHash('')).toThrow(RangeError);
    expect(() => imei.saltedHash('   ')).toThrow(RangeError);
  });

  it('refuses an HMAC key under 32 bytes', () => {
    const imei = expectValid(Imei.parse(valid));
    expect(() => imei.hmac('short')).toThrow(RangeError);
    expect(imei.hmac('x'.repeat(32))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the HMAC differs from the salted hash for the same secret', () => {
    // Different constructions on purpose: saltedHash is compat-only, hmac is for server keys.
    const imei = expectValid(Imei.parse(valid));
    const secret = 'x'.repeat(32);
    expect(imei.hmac(secret)).not.toBe(imei.saltedHash(secret));
  });
});

describe('Imei.luhnCheckDigit', () => {
  it.each(['35310411234567', '86124503111111', '00000000000000'])(
    'the check digit makes %s Luhn-valid',
    (body) => {
      expect(Imei.parse(body + Imei.luhnCheckDigit(body)).kind).toBe('valid');
    },
  );

  it('rejects a Luhn body of the wrong length', () => {
    expect(() => Imei.luhnCheckDigit('123')).toThrow(RangeError);
    expect(() => Imei.luhnCheckDigit(valid)).toThrow(RangeError);
  });

  it('rejects a non-numeric body', () => {
    expect(() => Imei.luhnCheckDigit('3531041123456x')).toThrow(RangeError);
  });
});

describe('golden vectors shared with check-this-phone', () => {
  const doc = JSON.parse(
    readFileSync(new URL('../../../testdata/imei-vectors.json', import.meta.url), 'utf8'),
  ) as {
    salt: string;
    cases: Array<{
      raw: string;
      kind: ImeiParse['kind'];
      digits?: string;
      tac?: string;
      masked?: string;
      digitsFound?: number;
      sha256_salted?: string;
      note?: string;
    }>;
  };

  it('has vectors to check', () => {
    expect(doc.cases.length).toBeGreaterThan(10);
  });

  it.each(doc.cases.map((c) => [c.note ?? (c.raw.slice(0, 40) || '(empty)'), c] as const))(
    'vector: %s',
    (_name, c) => {
      const parsed = Imei.parse(c.raw);
      expect(parsed.kind).toBe(c.kind);

      if (parsed.kind === 'valid') {
        if (c.digits !== undefined) expect(parsed.imei.digits).toBe(c.digits);
        if (c.tac !== undefined) expect(parsed.imei.typeAllocationCode).toBe(c.tac);
        if (c.masked !== undefined) expect(parsed.imei.masked()).toBe(c.masked);
        if (c.sha256_salted !== undefined) {
          expect(parsed.imei.saltedHash(doc.salt)).toBe(c.sha256_salted);
        }
      }
      if (parsed.kind === 'wrong_length' && c.digitsFound !== undefined) {
        expect(parsed.digitsFound).toBe(c.digitsFound);
      }
      if (parsed.kind === 'checksum_failed' && c.masked !== undefined) {
        expect(parsed.masked).toBe(c.masked);
      }
    },
  );
});
