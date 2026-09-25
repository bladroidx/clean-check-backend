import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ImeiCipher, ImeiDecryptError } from '../src/crypto/imei-cipher.js';

const k = () => randomBytes(32).toString('base64');
const DIGITS = '8'.repeat(15);

describe('ImeiCipher', () => {
  it('round-trips and never contains the digits', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    const { ciphertext, keyVersion } = c.encrypt(DIGITS, 'chk_1');
    expect(ciphertext.toString('latin1')).not.toContain(DIGITS);
    expect(c.decrypt(ciphertext, keyVersion, 'chk_1')).toBe(DIGITS);
  });
  it('fresh nonce per encryption', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    expect(c.encrypt(DIGITS, 'a').ciphertext.equals(c.encrypt(DIGITS, 'a').ciphertext)).toBe(false);
  });
  it('ciphertext moved to another check fails', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    const { ciphertext } = c.encrypt(DIGITS, 'chk_1');
    expect(() => c.decrypt(ciphertext, 1, 'chk_2')).toThrow(ImeiDecryptError);
  });
  it('tampering fails', () => {
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    const { ciphertext } = c.encrypt(DIGITS, 'x');
    ciphertext.writeUInt8(ciphertext.readUInt8(14) ^ 1, 14);
    expect(() => c.decrypt(ciphertext, 1, 'x')).toThrow(ImeiDecryptError);
  });
  it('rotation: encrypts with the highest version, still decrypts the old one', () => {
    const k1 = k();
    const old = ImeiCipher.fromKeyring(`1:${k1}`).encrypt(DIGITS, 'x');
    const c = ImeiCipher.fromKeyring(`1:${k1},2:${k()}`);
    expect(c.currentVersion).toBe(2);
    expect(c.decrypt(old.ciphertext, 1, 'x')).toBe(DIGITS);
  });
  it('refuses a short key and never echoes it', () => {
    // Without this, a fromKeyring that stopped throwing would skip the catch and pass silently.
    expect.assertions(2);
    const short = Buffer.alloc(16).toString('base64');
    expect(() => ImeiCipher.fromKeyring(`1:${short}`)).toThrow(/32 bytes/);
    try { ImeiCipher.fromKeyring(`1:${short}`); } catch (e) { expect(String(e)).not.toContain(short); }
  });
  it('error messages never contain digits', () => {
    expect.assertions(1);
    const c = ImeiCipher.fromKeyring(`1:${k()}`);
    try { c.decrypt(Buffer.alloc(40), 1, 'x'); } catch (e) { expect(String(e)).not.toMatch(/\d{14,}/); }
  });
});
