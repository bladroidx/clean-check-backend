import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The ONE place an IMEI is encrypted or decrypted (ADR-0007).
 *
 * AES-256-GCM, fresh 12-byte nonce per row, AAD = check id so a ciphertext copied onto another
 * row fails authentication. Layout: nonce(12) || ciphertext || tag(16). Nothing here ever logs,
 * throws or returns key material or digits in a message. `packages/core/test/cipher-boundary.test.ts`
 * greps the whole workspace and fails if any other file calls `createCipheriv`/`createDecipheriv`.
 */
const NONCE = 12;
const TAG = 16;

export class ImeiDecryptError extends Error {
  constructor() {
    super('IMEI ciphertext could not be decrypted (wrong key version, wrong check, or tampered)');
    this.name = 'ImeiDecryptError';
  }
}

export class ImeiCipher {
  private constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    readonly currentVersion: number,
  ) {}

  /**
   * Parses `IMEI_ENCRYPTION_KEYS`: `"<version>:<base64 32-byte key>[,...]"`. Current = highest
   * version, so rotation is "add a new highest entry" and old entries stay only as long as some
   * row still references them.
   */
  static fromKeyring(spec: string): ImeiCipher {
    const keys = new Map<number, Buffer>();
    for (const part of spec
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)) {
      const sep = part.indexOf(':');
      const version = Number(part.slice(0, sep));
      if (sep <= 0 || !Number.isInteger(version) || version < 1) {
        throw new Error('IMEI_ENCRYPTION_KEYS: each entry must be "<version>:<base64 key>"');
      }
      if (keys.has(version)) {
        throw new Error(`IMEI_ENCRYPTION_KEYS: version ${version} appears twice`);
      }
      const key = Buffer.from(part.slice(sep + 1), 'base64');
      if (key.length !== 32) {
        throw new Error(`IMEI_ENCRYPTION_KEYS: version ${version} must decode to exactly 32 bytes`);
      }
      keys.set(version, key);
    }
    if (keys.size === 0) throw new Error('IMEI_ENCRYPTION_KEYS: no keys');
    return new ImeiCipher(keys, Math.max(...keys.keys()));
  }

  /** Always encrypts under `currentVersion` -- the highest key in the ring. */
  encrypt(digits: string, checkId: string): { ciphertext: Buffer; keyVersion: number } {
    const key = this.keys.get(this.currentVersion);
    if (key === undefined) throw new Error('ImeiCipher: current version has no key (unreachable)');
    const nonce = randomBytes(NONCE);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(checkId, 'utf8'));
    const body = Buffer.concat([cipher.update(digits, 'utf8'), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]), keyVersion: this.currentVersion };
  }

  /** Throws `ImeiDecryptError` on a missing key version, wrong `checkId`, or tampering. */
  decrypt(ciphertext: Buffer, keyVersion: number, checkId: string): string {
    const key = this.keys.get(keyVersion);
    if (key === undefined || ciphertext.length < NONCE + TAG + 1) throw new ImeiDecryptError();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, NONCE));
      decipher.setAAD(Buffer.from(checkId, 'utf8'));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG));
      return Buffer.concat([
        decipher.update(ciphertext.subarray(NONCE, ciphertext.length - TAG)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ImeiDecryptError();
    }
  }
}
