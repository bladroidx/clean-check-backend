import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DhruLegacyProvider } from '../src/dhru/legacy.js';
import { DhruRestProvider } from '../src/dhru/rest.js';
import { BUILTIN_LEXICONS } from '../src/normalise/lexicons.js';
import type { CatalogueService } from '../src/types.js';

/**
 * Fixture replay: the 15-case matrix.
 *
 * Every case here is a real supplier response shape. Fixtures rather than live calls because the
 * failure this suite exists to catch is **format drift** -- a supplier changing their wording
 * without telling anyone -- and you cannot regression-test against a moving target.
 *
 * The most important test in the file is `legacy-blacklist-reworded`: a supplier who has renamed
 * "Clean" to "No records found". It must produce a MISS, not a pass.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'dhru');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

const blacklistService: CatalogueService = {
  serviceId: '12',
  providerId: 'alpha',
  displayName: 'blacklist',
  capabilities: ['blacklist.gsma'],
  fields: ['blacklist.status', 'blacklist.reported_by', 'blacklist.reported_at', 'identity.model', 'identity.manufacturer'],
  lexiconId: 'blacklist',
  costUsd: 0.12,
  credits: 3,
  async: false,
  timeoutMs: 15000,
  appliesToTacPrefixes: ['*'],
  enabled: true,
};

const appleService: CatalogueService = {
  ...blacklistService,
  serviceId: '30',
  capabilities: ['lock.activation', 'lock.carrier', 'lock.mdm', 'warranty.purchase_date', 'network.sold_by'],
  fields: [
    'lock.activation.status',
    'lock.carrier.status',
    'lock.carrier.network',
    'lock.mdm.status',
    'warranty.purchase_date',
    'network.sold_by',
    'identity.model',
    'identity.manufacturer',
  ],
  lexiconId: 'apple-basic',
};

const legacy = new DhruLegacyProvider({
  providerId: 'alpha',
  baseUrl: 'https://example.invalid',
  username: 'u',
  apiAccessKey: 'k',
  services: [blacklistService, appleService],
  lexicons: BUILTIN_LEXICONS,
});

const rest = new DhruRestProvider({
  providerId: 'beta',
  baseUrl: 'https://example.invalid',
  token: 't',
  services: [blacklistService],
  lexicons: BUILTIN_LEXICONS,
});

describe('DHRU legacy transport', () => {
  it('reads a clean blacklist as a recognised value, not as an absence', () => {
    const outcome = legacy.interpret(fixture('legacy-blacklist-clean.json'), blacklistService);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'blacklist.status', value: 'clean' }),
    );
    expect(outcome.misses).toEqual([]);
  });

  it('reads a blocked device, including who reported it and when', () => {
    const outcome = legacy.interpret(fixture('legacy-blacklist-blocked.json'), blacklistService);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'blacklist.status', value: 'blocked' }),
    );
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'blacklist.reported_by', value: 'Vodafone UK' }),
    );
  });

  /**
   * The test the product rests on.
   *
   * A supplier has reworded "Clean" to "No records found in our database". Absence of the word
   * "blacklisted" is NOT proof of clean. If this ever produces a `blacklist.status` value, the
   * service has started certifying stolen phones.
   */
  it('records a MISS for a reworded status rather than inventing a clean answer', () => {
    const outcome = legacy.interpret(fixture('legacy-blacklist-reworded.json'), blacklistService);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;

    expect(outcome.fields.find((f) => f.field === 'blacklist.status')).toBeUndefined();
    expect(outcome.misses).toContainEqual(
      expect.objectContaining({
        field: 'blacklist.status',
        rawValue: 'No records found in our database',
      }),
    );
  });

  it('treats STATUS: Pending as pending, not as an empty clean result', () => {
    const outcome = legacy.interpret(fixture('legacy-pending.json'), blacklistService);
    expect(outcome.kind).toBe('pending');
    if (outcome.kind !== 'pending') return;
    expect(outcome.orderReference).toBe('918276');
  });

  it('classifies a DHRU error arriving with HTTP 200', () => {
    const invalid = legacy.interpret(fixture('legacy-error-invalid-imei.json'), blacklistService);
    expect(invalid.kind).toBe('rejected');
    if (invalid.kind === 'rejected') expect(invalid.reason).toBe('invalid_imei');

    const unsupported = legacy.interpret(fixture('legacy-error-unsupported.json'), blacklistService);
    expect(unsupported.kind).toBe('rejected');
    if (unsupported.kind === 'rejected') expect(unsupported.reason).toBe('device_not_supported');
  });

  it('treats a rejected order as an answer about coverage', () => {
    const outcome = legacy.interpret(fixture('legacy-rejected.json'), blacklistService);
    expect(outcome.kind).toBe('rejected');
  });

  it('refuses an empty RESULT rather than normalising it to nothing-found', () => {
    const outcome = legacy.interpret(fixture('legacy-empty-result.json'), blacklistService);
    // An empty blob normalises to zero fields, which downstream is indistinguishable from a clean
    // device. Failing here is what keeps that from happening.
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toBe('malformed_response');
  });

  it('handles the nested SUCCESS shape some sellers emit', () => {
    const outcome = legacy.interpret(fixture('legacy-nested-success.json'), blacklistService);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'blacklist.status', value: 'clean' }),
    );
  });

  it('degrades a corrupt body to failed, never to an answer', () => {
    const outcome = legacy.interpret(fixture('legacy-corrupt.txt'), blacklistService);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toBe('malformed_response');
  });

  it('refuses a service with no registered lexicon instead of returning zero fields', () => {
    const orphan = { ...blacklistService, lexiconId: 'no-such-lexicon' };
    const outcome = legacy.interpret(fixture('legacy-blacklist-clean.json'), orphan);
    expect(outcome.kind).toBe('failed');
  });
});

describe('the polarity trap', () => {
  it('reads "Find My iPhone: ON" as the lock being ON', () => {
    const outcome = legacy.interpret(fixture('legacy-apple-locked.json'), appleService);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'lock.activation.status', value: 'on' }),
    );
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'lock.carrier.status', value: 'locked' }),
    );
  });

  /**
   * "Clean" means the lock is OFF here, and `clean` in `blacklist.status`. The same adjective,
   * opposite facts about the device. This is why polarity is declared per field and never inferred.
   */
  it('reads "Find My iPhone: Clean" as the lock being OFF', () => {
    const outcome = legacy.interpret(fixture('legacy-apple-clean.json'), appleService);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'lock.activation.status', value: 'off' }),
    );
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'lock.mdm.status', value: 'off' }),
    );
  });

  it('parses both ISO and US purchase dates into an ISO instant', () => {
    const iso = legacy.interpret(fixture('legacy-apple-locked.json'), appleService);
    const us = legacy.interpret(fixture('legacy-apple-clean.json'), appleService);
    if (iso.kind !== 'answered' || us.kind !== 'answered') throw new Error('expected answers');

    expect(iso.fields.find((f) => f.field === 'warranty.purchase_date')?.value).toBe(
      '2023-01-04T00:00:00.000Z',
    );
    expect(us.fields.find((f) => f.field === 'warranty.purchase_date')?.value).toBe(
      '2022-03-14T00:00:00.000Z',
    );
  });

  it('decodes HTML entities so a carrier name is not mangled', () => {
    const outcome = legacy.interpret(fixture('legacy-apple-locked.json'), appleService);
    if (outcome.kind !== 'answered') throw new Error('expected an answer');
    expect(outcome.fields.find((f) => f.field === 'lock.carrier.network')?.value).toBe('AT&T USA');
  });
});

describe('DHRU REST transport', () => {
  it('normalises a JSON result object', () => {
    const outcome = rest.interpret(fixture('rest-answered.json'), blacklistService);
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.fields).toContainEqual(
      expect.objectContaining({ field: 'blacklist.status', value: 'clean' }),
    );
  });

  it('reports a pending order with its reference', () => {
    const outcome = rest.interpret(fixture('rest-pending.json'), blacklistService);
    expect(outcome.kind).toBe('pending');
    if (outcome.kind === 'pending') expect(outcome.orderReference).toBe('ord_5513');
  });

  it('classifies a rejection', () => {
    const outcome = rest.interpret(fixture('rest-rejected.json'), blacklistService);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reason).toBe('service_not_available_for_device');
  });
});
