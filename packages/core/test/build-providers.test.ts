import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProviders } from '../src/providers/build.js';

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
