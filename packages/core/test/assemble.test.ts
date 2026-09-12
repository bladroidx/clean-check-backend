import { describe, expect, it, vi } from 'vitest';
import type { Coverage } from '@imei-check/contract';
import type { ProviderOutcome } from '@imei-check/providers';
import { assembleSection, deriveWarrantyStatus } from '../src/report/assemble.js';
import { coverageFor } from '../src/report/coverage.js';
import { InMemoryTacDirectory } from '@imei-check/identity';

/**
 * Arm selection: the single choke point.
 *
 * Every test in this file asks one question in a different way: **can a provider outcome that is
 * not a positive known-good match ever produce a `pass`?** The answer must be no, whatever shape
 * the outcome arrives in.
 */

const directory = InMemoryTacDirectory.from(
  [['35310411', { manufacturer: 'Apple', model: 'iPhone 13', source: 'bundled' }]],
  'test-1',
);
const CHECKED_AT = new Date('2026-09-13T12:00:00.000Z');
const blacklistCoverage: Coverage = coverageFor('blacklist.gsma', directory);

function assemble(outcome: ProviderOutcome, onMiss?: () => void) {
  return assembleSection({
    capability: 'blacklist.gsma',
    outcome,
    coverage: blacklistCoverage,
    checkedAt: CHECKED_AT,
    ...(onMiss !== undefined ? { onLexiconMiss: onMiss } : {}),
  });
}

describe('the four arms', () => {
  it('a positive known-good match is a pass, with evidence', () => {
    const section = assemble({
      kind: 'answered',
      fields: [{ field: 'blacklist.status', value: 'clean' }],
      misses: [],
    });
    expect(section.outcome).toBe('pass');
    expect(section.evidence).toEqual([
      { type: 'flag', label: 'Block-list entry', value: false },
    ]);
    // Invariant 6: a clean GSMA answer without caveats is a misleading statement, not a true one.
    expect(section.coverage.caveats.length).toBeGreaterThan(0);
  });

  it('a known-bad match is a fail, with a finding', () => {
    const section = assemble({
      kind: 'answered',
      fields: [{ field: 'blacklist.status', value: 'blocked' }],
      misses: [],
    });
    expect(section.outcome).toBe('fail');
    expect(section.finding?.severity).toBe('critical');
    expect(section.evidence[0]).toEqual({ type: 'flag', label: 'Block-list entry', value: true });
  });

  /** The parsing rule, at the arm-selection layer. */
  it('an unrecognised value is inconclusive and raises the drift signal', () => {
    const onMiss = vi.fn();
    const section = assemble(
      {
        kind: 'answered',
        fields: [],
        misses: [{ field: 'blacklist.status', rawValue: 'No records found', serviceId: '12' }],
      },
      onMiss,
    );
    expect(section.outcome).toBe('inconclusive');
    expect(section.reason).toBe('unrecognised_provider_value');
    // An inconclusive with no remedy reads to a buyer exactly like a failure.
    expect(section.remedy).toBeDefined();
    expect(onMiss).toHaveBeenCalledOnce();
  });

  it('an answer that says nothing about this capability is inconclusive, never pass', () => {
    const section = assemble({ kind: 'answered', fields: [], misses: [] });
    expect(section.outcome).toBe('inconclusive');
    expect(section.reason).toBe('device_not_found_in_registry');
  });

  it('a timeout is unavailable, never a pass and never an error', () => {
    const section = assemble({ kind: 'failed', reason: 'timeout' });
    expect(section.outcome).toBe('unavailable');
    expect(section.reason).toBe('provider_timeout');
    // Coverage is still present: it says what a good answer WOULD have covered.
    expect(section.coverage.registries.length).toBeGreaterThan(0);
  });

  it('an open circuit is unavailable(circuit_open)', () => {
    const section = assemble({ kind: 'failed', reason: 'circuit_open' });
    expect(section.reason).toBe('circuit_open');
  });

  it('our own auth failure is unavailable, distinguishable on a dashboard', () => {
    const section = assemble({ kind: 'failed', reason: 'auth_error' });
    expect(section.outcome).toBe('unavailable');
    expect(section.reason).toBe('provider_not_configured');
  });

  it('a pending order is inconclusive(awaiting_provider) with a remedy', () => {
    const section = assemble({ kind: 'pending', orderReference: 'o1' });
    expect(section.outcome).toBe('inconclusive');
    expect(section.reason).toBe('awaiting_provider');
    expect(section.remedy).toBe('retry_later');
  });

  it('a rejection is unavailable with a coverage reason, not a failure', () => {
    const section = assemble({ kind: 'rejected', reason: 'device_not_supported' });
    expect(section.outcome).toBe('unavailable');
    expect(section.reason).toBe('capability_not_supported_for_device');
  });

  /**
   * The boundary that renders "not in the registry" as a green tick when it is got wrong.
   * "We asked and got a non-answer" is inconclusive; "we never got an answer" is unavailable.
   */
  it('keeps the inconclusive/unavailable boundary in the right place', () => {
    expect(assemble({ kind: 'answered', fields: [], misses: [] }).outcome).toBe('inconclusive');
    expect(assemble({ kind: 'failed', reason: 'timeout' }).outcome).toBe('unavailable');
  });

  it('never charges the caller a pass for a value outside the polarity table', () => {
    const section = assemble({
      kind: 'answered',
      // A value the lexicon produced but the polarity table has no entry for: still not a pass.
      fields: [{ field: 'blacklist.status', value: 'probably_fine' }],
      misses: [],
    });
    expect(section.outcome).toBe('inconclusive');
  });
});

describe('activation lock polarity', () => {
  const coverage = coverageFor('lock.activation', directory);
  const at = (value: string) =>
    assembleSection({
      capability: 'lock.activation',
      outcome: { kind: 'answered', fields: [{ field: 'lock.activation.status', value }], misses: [] },
      coverage,
      checkedAt: CHECKED_AT,
    });

  it('"on" is a critical finding, "off" is a pass', () => {
    expect(at('on').outcome).toBe('fail');
    expect(at('on').finding?.severity).toBe('critical');
    expect(at('off').outcome).toBe('pass');
  });
});

describe('derived warranty status', () => {
  const coverage = coverageFor('warranty.status', directory);

  it('is a pass inside the period, computed not bought', () => {
    const section = deriveWarrantyStatus({
      purchaseDateIso: '2026-06-01T00:00:00.000Z',
      coverage,
      checkedAt: CHECKED_AT,
    });
    expect(section.outcome).toBe('pass');
    expect(section.evidence[0]).toEqual({
      type: 'flag',
      label: 'Within the standard warranty period',
      value: true,
    });
  });

  /**
   * Out of warranty is a fact about an old phone, not a defect in it. `fail` would defame an
   * honest second-hand device and `pass` would claim something we did not verify.
   */
  it('is inconclusive, not fail, once the period has elapsed', () => {
    const section = deriveWarrantyStatus({
      purchaseDateIso: '2019-01-01T00:00:00.000Z',
      coverage,
      checkedAt: CHECKED_AT,
    });
    expect(section.outcome).toBe('inconclusive');
    expect(section.remedy).toBe('no_action_possible');
  });
});

describe('failure reasons map exhaustively', () => {
  const cases = [
    ['timeout', 'provider_timeout'],
    ['transport_error', 'provider_error'],
    ['http_error', 'provider_error'],
    ['malformed_response', 'provider_error'],
    ['auth_error', 'provider_not_configured'],
    ['insufficient_provider_balance', 'provider_not_configured'],
    ['rate_limited', 'rate_limited_upstream'],
    ['circuit_open', 'circuit_open'],
  ] as const;

  it.each(cases)('%s becomes unavailable(%s)', (reason, expected) => {
    const section = assemble({ kind: 'failed', reason });
    expect(section.outcome).toBe('unavailable');
    expect(section.reason).toBe(expected);
  });

  const rejections = [
    ['device_not_supported', 'capability_not_supported_for_device'],
    ['invalid_imei', 'capability_not_supported_for_device'],
    ['service_not_available_for_device', 'provider_no_coverage'],
    ['device_not_found', 'provider_no_coverage'],
    ['duplicate_order', 'provider_no_coverage'],
  ] as const;

  it.each(rejections)('a %s rejection becomes unavailable(%s)', (reason, expected) => {
    const section = assemble({ kind: 'rejected', reason });
    expect(section.outcome).toBe('unavailable');
    expect(section.reason).toBe(expected);
  });
});

describe('factual capabilities', () => {
  it('a purchase date is evidence, never a judgement', () => {
    const section = assembleSection({
      capability: 'warranty.purchase_date',
      outcome: {
        kind: 'answered',
        fields: [{ field: 'warranty.purchase_date', value: '2023-01-04T00:00:00.000Z' }],
        misses: [],
      },
      coverage: coverageFor('warranty.purchase_date', directory),
      checkedAt: CHECKED_AT,
    });
    expect(section.outcome).toBe('pass');
    expect(section.evidence[0]).toEqual({
      type: 'date',
      label: 'Purchase date',
      value: '2023-01-04T00:00:00.000Z',
    });
  });

  it('identity carries manufacturer and model as text, deciding field first', () => {
    const section = assembleSection({
      capability: 'identity.model',
      outcome: {
        kind: 'answered',
        fields: [
          { field: 'identity.manufacturer', value: 'Apple' },
          { field: 'identity.model', value: 'iPhone 13' },
        ],
        misses: [],
      },
      coverage: coverageFor('identity.model', directory),
      checkedAt: CHECKED_AT,
    });
    expect(section.evidence[0]).toEqual({ type: 'text', label: 'Model', value: 'iPhone 13' });
  });

  it('a cached section reports its freshness truthfully', () => {
    const section = assembleSection({
      capability: 'blacklist.gsma',
      outcome: {
        kind: 'answered',
        fields: [{ field: 'blacklist.status', value: 'clean' }],
        misses: [],
      },
      coverage: blacklistCoverage,
      checkedAt: CHECKED_AT,
      freshness: { cached: true, age_seconds: 600, ttl_seconds: 3600 },
    });
    expect(section.freshness).toEqual({ cached: true, age_seconds: 600, ttl_seconds: 3600 });
  });
});

describe('redaction at the choke point', () => {
  /**
   * The leak the sentinel test found: an adapter-constructed `detail` never passes through the
   * transport's scrubber, so the last line of defence has to be here.
   */
  it('scrubs IMEI-shaped digits out of a supplier-authored detail', () => {
    const section = assemble({
      kind: 'failed',
      reason: 'http_error',
      detail: 'provider said: no record for 353104112345676',
    });
    expect(section.detail).not.toContain('353104112345676');
    expect(section.detail).toContain('[REDACTED-IMEI]');
  });

  it('scrubs a value echoed into text evidence', () => {
    const section = assembleSection({
      capability: 'identity.model',
      outcome: {
        kind: 'answered',
        fields: [{ field: 'identity.model', value: 'iPhone 13 (353104112345676)' }],
        misses: [],
      },
      coverage: coverageFor('identity.model', directory),
      checkedAt: CHECKED_AT,
    });
    expect(JSON.stringify(section)).not.toContain('353104112345676');
  });

  it('leaves a decimal alone, which is not an IMEI', () => {
    const section = assemble({
      kind: 'failed',
      reason: 'timeout',
      detail: 'gave up after 6.8965530000627041 seconds',
    });
    expect(section.detail).toContain('6.8965530000627041');
  });
});

describe('an unsupplied capability', () => {
  /**
   * A gap in our own supply is not a supplier outage. Conflating them means a missing catalogue
   * entry pages someone at 3am about an upstream that is perfectly healthy.
   */
  it('is unavailable(provider_not_configured), never provider_error', () => {
    const section = assemble({
      kind: 'failed',
      reason: 'no_provider_configured',
      detail: 'No data source is configured for this check.',
    });
    expect(section.outcome).toBe('unavailable');
    expect(section.reason).toBe('provider_not_configured');
  });
});
