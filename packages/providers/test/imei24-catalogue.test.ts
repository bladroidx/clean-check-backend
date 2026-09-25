import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalogueFile } from '../src/catalogue.js';
import { DhruLegacyProvider } from '../src/dhru/legacy.js';
import { BUILTIN_LEXICONS } from '../src/normalise/lexicons.js';

const CATALOGUE = join(import.meta.dirname, '..', 'catalogue', 'imei24.yaml');
const FIX = join(import.meta.dirname, 'fixtures', 'imei24');
const services = loadCatalogueFile(CATALOGUE);
const provider = new DhruLegacyProvider({
  providerId: 'imei24', baseUrl: 'https://pro.imei24.com', username: 'u', apiAccessKey: 'k',
  services, lexicons: BUILTIN_LEXICONS,
});
const svc = (id: string) => {
  const s = services.find((x) => x.serviceId === id);
  if (s === undefined) throw new Error(`no service ${id}`);
  return s;
};
const body = (name: string) => readFileSync(join(FIX, name), 'utf8');

describe('imei24 catalogue', () => {
  it('loads, every service is imei24, credits are 0, every lexicon exists', () => {
    expect(services.length).toBeGreaterThanOrEqual(13);
    for (const s of services) {
      expect(s.providerId).toBe('imei24');
      expect(s.credits).toBe(0);
      expect(BUILTIN_LEXICONS.some((l) => l.providerId === 'imei24' && l.lexiconId === s.lexiconId)).toBe(true);
    }
  });

  it('486 is the only wildcard blacklist service', () => {
    const wild = services.filter((s) => s.appliesToTacPrefixes.includes('*'));
    expect(wild.map((s) => s.serviceId)).toEqual(['486']);
  });
});

describe('imei24 lexicons ship with no known-good phrases', () => {
  it('a "Clean" blacklist answer is a MISS, not a pass', () => {
    const outcome = provider.interpret(body('blacklist-clean-wording.json'), svc('486'));
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') throw new Error('unreachable');
    expect(outcome.fields.find((f) => f.field === 'blacklist.status')).toBeUndefined();
    expect(outcome.misses.map((m) => m.field)).toContain('blacklist.status');
  });

  it('"Blacklisted" is a known-bad value', () => {
    const outcome = provider.interpret(body('blacklist-blacklisted.json'), svc('486'));
    if (outcome.kind !== 'answered') throw new Error('unexpected ' + outcome.kind);
    expect(outcome.fields).toContainEqual(expect.objectContaining({ field: 'blacklist.status', value: 'blocked' }));
  });

  it('busy and not-found bodies', () => {
    expect(provider.interpret(body('busy.json'), svc('486'))).toMatchObject({ kind: 'failed', reason: 'rate_limited' });
    expect(provider.interpret(body('not-found.json'), svc('486'))).toMatchObject({ kind: 'rejected', reason: 'device_not_found' });
  });

  it('literal null warranty date is absent, model is text', () => {
    const outcome = provider.interpret(body('instant-model.json'), svc('428'));
    if (outcome.kind !== 'answered') throw new Error('unexpected ' + outcome.kind);
    expect(outcome.fields.some((f) => f.field === 'warranty.purchase_date')).toBe(false);
    expect(outcome.misses).toEqual([]);
  });
});
