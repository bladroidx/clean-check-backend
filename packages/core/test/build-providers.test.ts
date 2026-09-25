import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProviders, imei24CredentialsFromEnv } from '../src/providers/build.js';

const DIR = join(import.meta.dirname, '..', '..', 'providers', 'catalogue');

describe('buildProviders', () => {
  it('skips imei24 by name when credentials are absent', () => {
    const built = buildProviders({ catalogueDir: DIR });
    expect(built.providers).toEqual([]);
    expect(built.skipped).toEqual([{ providerId: 'imei24', reason: 'IMEI24_USERNAME/IMEI24_API_KEY not set' }]);
  });
  it('builds imei24 as a DHRU provider when configured', () => {
    const built = buildProviders({ catalogueDir: DIR, imei24: { baseUrl: 'https://pro.imei24.com', username: 'ops@example.com', apiKey: 'k' } });
    expect(built.providers.map((p) => p.id)).toEqual(['imei24']);
    expect(built.catalogue.every((s) => s.providerId === 'imei24')).toBe(true);
  });
});

/** R19: shared by the API config and the worker, so both refuse half-set credentials alike. */
describe('imei24CredentialsFromEnv', () => {
  it('is undefined when neither is set, and builds credentials when both are', () => {
    expect(imei24CredentialsFromEnv({})).toBeUndefined();
    expect(imei24CredentialsFromEnv({ IMEI24_USERNAME: '', IMEI24_API_KEY: '' })).toBeUndefined();
    expect(imei24CredentialsFromEnv({ IMEI24_USERNAME: 'ops@example.com', IMEI24_API_KEY: 'k' })).toEqual({
      baseUrl: 'https://pro.imei24.com',
      username: 'ops@example.com',
      apiKey: 'k',
    });
  });

  it('throws on a partial pair, naming the variables and never the value', () => {
    expect.assertions(4);
    for (const env of [{ IMEI24_USERNAME: 'ops@example.com' }, { IMEI24_API_KEY: 'sk-secret' }]) {
      try {
        imei24CredentialsFromEnv(env);
      } catch (e) {
        expect(String(e)).toMatch(/IMEI24_USERNAME and IMEI24_API_KEY/);
        expect(String(e)).not.toMatch(/sk-secret|ops@example/);
      }
    }
  });
});
