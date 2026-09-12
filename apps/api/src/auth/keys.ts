import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys.
 *
 * Stored as SHA-256 plus an indexed display prefix. Deliberately **not** argon2 or bcrypt: those
 * defend a low-entropy secret against an offline dictionary, and a 256-bit random key has no
 * dictionary to defeat. A slow KDF here would buy nothing and cost 50 ms on every single request.
 *
 * The prefix is what lets an operator identify a key in a list, and a leaked key in a log or a
 * GitHub push, without the database holding anything that can be replayed.
 */

const PREFIX_LIVE = 'imc_live_';
const PREFIX_TEST = 'imc_test_';
const KEY_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = 12;

/** RFC 4648 base32 without padding, upper-cased -- no ambiguous glyphs when read aloud. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export interface GeneratedKey {
  /** Shown to the operator exactly once. Never stored, never logged. */
  readonly plaintext: string;
  readonly sha256: string;
  readonly prefix: string;
}

export function generateApiKey(live = true): GeneratedKey {
  const plaintext = `${live ? PREFIX_LIVE : PREFIX_TEST}${base32(randomBytes(KEY_BYTES))}`;
  return {
    plaintext,
    sha256: hashApiKey(plaintext),
    prefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext.trim(), 'utf8').digest('hex');
}

export function displayPrefix(plaintext: string): string {
  return plaintext.trim().slice(0, DISPLAY_PREFIX_LENGTH);
}

export function looksLikeApiKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(PREFIX_LIVE) || trimmed.startsWith(PREFIX_TEST);
}

/**
 * Constant-time compare for the hex digests.
 *
 * The lookup is by hash so a timing difference leaks little, but "little" is not "none" and the
 * comparison is free to do properly.
 */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Extracts a bearer credential.
 *
 * Returns undefined rather than throwing, and never echoes the value it saw -- an auth error that
 * quotes the credential puts it in the log of every failed request.
 */
export function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
