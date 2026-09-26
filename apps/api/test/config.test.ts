import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * The pepper guard.
 *
 * `Imei.saltedHash` refuses a blank salt, but that is a per-call check on one code path. The
 * length floor has to hold for the whole process, and a weak pepper is not a degraded mode: the
 * 15-digit space is enumerable in seconds, so a short pepper pseudonymises nothing at all.
 */

const GOOD_PEPPER = 'x'.repeat(32);
const base = { SERVER_PEPPER: GOOD_PEPPER } as NodeJS.ProcessEnv;
const GOOD_KEYRING = `1:${randomBytes(32).toString('base64')}`;
const DB_URL = 'postgres://user:pass@localhost:5432/imei_check';

describe('loadConfig', () => {
  it('accepts a 32-byte pepper and applies the defaults', () => {
    const c = loadConfig({ SERVER_PEPPER: GOOD_PEPPER } as NodeJS.ProcessEnv);
    expect(c.NODE_ENV).toBe('development');
    expect(c.PORT).toBe(3000);
    expect(c.LOG_LEVEL).toBe('info');
  });

  it('refuses to boot with no pepper at all', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/SERVER_PEPPER/);
  });

  it('refuses a pepper one byte under the floor, and says why', () => {
    expect(() => loadConfig({ SERVER_PEPPER: 'x'.repeat(31) } as NodeJS.ProcessEnv)).toThrow(
      /at least 32 bytes/,
    );
    expect(() => loadConfig({ SERVER_PEPPER: 'x'.repeat(31) } as NodeJS.ProcessEnv)).toThrow(
      /enumerable in seconds/,
    );
  });

  it('measures the floor in BYTES, not characters', () => {
    // 31 four-byte emoji is 124 bytes: long enough. 8 of them is 32 bytes: exactly the floor.
    expect(() => loadConfig({ SERVER_PEPPER: '🔒'.repeat(8) } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => loadConfig({ SERVER_PEPPER: '🔒'.repeat(7) } as NodeJS.ProcessEnv)).toThrow();
  });

  it('reports every problem at once, not one per restart', () => {
    // A boot failure that reveals one missing variable at a time wastes the operator's afternoon.
    try {
      loadConfig({ PORT: 'not-a-number', LOG_LEVEL: 'shouty' } as unknown as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('SERVER_PEPPER');
      expect(msg).toContain('PORT');
      expect(msg).toContain('LOG_LEVEL');
    }
  });

  it('rejects an out-of-range port and a non-url database', () => {
    expect(() => loadConfig({ SERVER_PEPPER: GOOD_PEPPER, PORT: '99999' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
    expect(() =>
      loadConfig({ SERVER_PEPPER: GOOD_PEPPER, DATABASE_URL: 'not-a-url' } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });

  it('never echoes the pepper value into the error message', () => {
    const secret = 'super-secret-but-too-short';
    try {
      loadConfig({ SERVER_PEPPER: secret } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('rejects a non-https IMEI24_BASE_URL', () => {
    expect(() => loadConfig({ ...base, IMEI24_BASE_URL: 'http://pro.imei24.com' } as NodeJS.ProcessEnv)).toThrow(
      /IMEI24_BASE_URL/,
    );
  });

  /**
   * R19: half-configured credentials used to be silently skipped -- imei24 simply not built, every
   * deep section `provider_not_configured` -- which looks like a supplier outage rather than the
   * typo it is. Refuse to boot instead, naming the variables and never echoing a value.
   */
  it('refuses to boot with only one of IMEI24_USERNAME / IMEI24_API_KEY', () => {
    const secret = 'sk-live-do-not-echo';
    for (const partial of [{ IMEI24_USERNAME: 'ops@example.com' }, { IMEI24_API_KEY: secret }]) {
      expect(() => loadConfig({ ...base, ...partial } as NodeJS.ProcessEnv)).toThrow(/IMEI24_USERNAME.*IMEI24_API_KEY|IMEI24_API_KEY.*IMEI24_USERNAME/);
      try {
        loadConfig({ ...base, ...partial } as NodeJS.ProcessEnv);
      } catch (e) {
        expect((e as Error).message).not.toContain(secret);
      }
    }
    // Both, or neither, is fine.
    expect(() => loadConfig(base)).not.toThrow();
    expect(() => loadConfig({ ...base, IMEI24_USERNAME: 'ops@example.com', IMEI24_API_KEY: secret } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('rejects a wait window above 12 s', () => {
    expect(() => loadConfig({ ...base, DEEP_CHECK_WAIT_MS: '15000' } as NodeJS.ProcessEnv)).toThrow(
      /DEEP_CHECK_WAIT_MS/,
    );
  });

  it('rejects a wait window below 1 s (it is also the budget for placing orders)', () => {
    expect(() => loadConfig({ ...base, DEEP_CHECK_WAIT_MS: '0' } as NodeJS.ProcessEnv)).toThrow(
      /DEEP_CHECK_WAIT_MS/,
    );
  });

  it('defaults', () => {
    const c = loadConfig(base);
    expect(c.IMEI24_BASE_URL).toBe('https://pro.imei24.com');
    expect(c.DEEP_CHECK_WAIT_MS).toBe(10_000);
    expect(c.IMEI24_DAILY_SPEND_USD).toBe(10);
  });

  describe('PUBLIC_BASE_URL', () => {
    // A private deployment (reachable only on an internal Docker network) has no public URL, and
    // compose can only pass an unset variable through as the empty string.
    it('treats an empty value as unset: no feedback_url, orders settle by polling', () => {
      expect(loadConfig({ ...base, PUBLIC_BASE_URL: '' }).PUBLIC_BASE_URL).toBeUndefined();
    });

    it('still refuses a value that is not a URL', () => {
      expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'imei-check' })).toThrow(/PUBLIC_BASE_URL/);
    });

    it('keeps a real URL', () => {
      expect(loadConfig({ ...base, PUBLIC_BASE_URL: 'https://imei.example.test' }).PUBLIC_BASE_URL).toBe(
        'https://imei.example.test',
      );
    });
  });

  describe('IMEI_ENCRYPTION_KEYS (ADR-0007)', () => {
    it('is not required without a database', () => {
      expect(() => loadConfig(base)).not.toThrow();
    });

    it('is required once DATABASE_URL is set', () => {
      expect(() =>
        loadConfig({ ...base, DATABASE_URL: DB_URL } as NodeJS.ProcessEnv),
      ).toThrow(/IMEI_ENCRYPTION_KEYS/);
    });

    it('boots with DATABASE_URL and a valid keyring', () => {
      const c = loadConfig({
        ...base,
        DATABASE_URL: DB_URL,
        IMEI_ENCRYPTION_KEYS: GOOD_KEYRING,
      } as NodeJS.ProcessEnv);
      expect(c.IMEI_ENCRYPTION_KEYS).toBe(GOOD_KEYRING);
    });

    it('rejects a malformed keyring and never echoes the key', () => {
      const badKey = Buffer.alloc(16).toString('base64');
      try {
        loadConfig({
          ...base,
          DATABASE_URL: DB_URL,
          IMEI_ENCRYPTION_KEYS: `1:${badKey}`,
        } as NodeJS.ProcessEnv);
        expect.unreachable('should have thrown');
      } catch (e) {
        const message = (e as Error).message;
        expect(message).toMatch(/IMEI_ENCRYPTION_KEYS/);
        expect(message).toMatch(/32 bytes/);
        expect(message).not.toContain(badKey);
      }
    });
  });
});
