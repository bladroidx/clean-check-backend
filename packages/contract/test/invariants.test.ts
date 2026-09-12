import { describe, expect, it } from 'vitest';
import type { Coverage, SectionResult } from '../src/envelope.js';
import { CheckReport, DISCLAIMER, SCHEMA_VERSION } from '../src/envelope.js';
import {
  InvariantViolation,
  assertEnvelopeInvariants,
  assertSectionInvariants,
  assertStatusInvariant,
  deriveVerdict,
} from '../src/invariants.js';
import { fail, inconclusive, pass, unavailable } from '../src/section.js';

const AT = new Date('2026-09-12T20:14:01.220Z');

const coverage = (caveats: string[] = ['A handset reported in the last 24-72h may not appear.']): Coverage => ({
  registries: ['gsma_imei_db'],
  caveats,
});

const cleanBlacklist = () =>
  pass({
    capability: 'blacklist.gsma',
    checkedAt: AT,
    coverage: coverage(),
    evidence: [{ type: 'flag', label: 'Block-list entry', value: false }],
  });

describe('invariant 1 — evidence on pass and fail', () => {
  it('rejects a pass with no evidence', () => {
    const s = { ...cleanBlacklist(), evidence: [] };
    expect(() => assertSectionInvariants(s)).toThrow(InvariantViolation);
    expect(() => assertSectionInvariants(s)).toThrow(/silently did nothing/);
  });

  it('rejects a fail with no evidence', () => {
    const s: SectionResult = {
      ...fail({
        capability: 'blacklist.gsma',
        checkedAt: AT,
        coverage: coverage(),
        evidence: [{ type: 'flag', label: 'Block-list entry', value: true }],
        finding: { key: 'blacklisted', severity: 'critical', summary: 'Reported lost or stolen.' },
      }),
      evidence: [],
    };
    expect(() => assertSectionInvariants(s)).toThrow(InvariantViolation);
  });

  it('permits an unavailable with no evidence', () => {
    const s = unavailable({
      capability: 'warranty.status',
      checkedAt: AT,
      coverage: coverage([]),
      reason: 'capability_not_supported_for_device',
    });
    expect(() => assertSectionInvariants(s)).not.toThrow();
  });
});

describe('invariant 2 — finding belongs to fail alone', () => {
  it('rejects a fail with no finding', () => {
    const s = { ...cleanBlacklist(), outcome: 'fail' as const };
    expect(() => assertSectionInvariants(s)).toThrow(/no finding/);
  });

  it('rejects a pass carrying a finding', () => {
    const s: SectionResult = {
      ...cleanBlacklist(),
      finding: { key: 'x', severity: 'low', summary: 'y' },
    };
    expect(() => assertSectionInvariants(s)).toThrow(/carries a finding/);
  });
});

describe('invariant 3 — inconclusive needs a reason and a remedy', () => {
  const base = inconclusive({
    capability: 'blacklist.gsma',
    checkedAt: AT,
    coverage: coverage(),
    reason: 'unrecognised_provider_value',
    remedy: 'retry_later',
  });

  it('accepts a well-formed inconclusive', () => {
    expect(() => assertSectionInvariants(base)).not.toThrow();
  });

  it('rejects one with no remedy', () => {
    const { remedy: _drop, ...rest } = base;
    expect(() => assertSectionInvariants(rest as SectionResult)).toThrow(/no remedy/);
  });

  it('rejects a remedy on any other arm', () => {
    expect(() => assertSectionInvariants({ ...cleanBlacklist(), remedy: 'retry_later' })).toThrow(
      /carries a remedy/,
    );
  });
});

describe('the inconclusive/unavailable boundary', () => {
  // "We asked and got a non-answer" is inconclusive. "We never got an answer" is unavailable.
  // Getting it backwards renders "not in the registry" as a green tick.
  it('rejects inconclusive with a never-got-an-answer reason', () => {
    const s: SectionResult = { ...cleanBlacklist(), outcome: 'inconclusive', reason: 'provider_timeout', remedy: 'retry_later' };
    expect(() => assertSectionInvariants(s)).toThrow(/that is 'unavailable'/);
  });

  it('rejects unavailable with a provider-answered reason', () => {
    const s: SectionResult = {
      ...cleanBlacklist(),
      outcome: 'unavailable',
      reason: 'device_not_found_in_registry',
      evidence: [],
    };
    expect(() => assertSectionInvariants(s)).toThrow(/that is 'inconclusive'/);
  });
});

describe('invariants 5 and 6 — checked_at and coverage on every arm', () => {
  it('rejects a missing or unparseable checked_at', () => {
    expect(() => assertSectionInvariants({ ...cleanBlacklist(), checked_at: 'not a date' })).toThrow(
      /checked_at/,
    );
  });

  it('rejects a clean blacklist result with no caveats', () => {
    const s = pass({
      capability: 'blacklist.gsma',
      checkedAt: AT,
      coverage: coverage([]),
      evidence: [{ type: 'flag', label: 'Block-list entry', value: false }],
    });
    expect(() => assertSectionInvariants(s)).toThrow(/misleading one/);
  });
});

describe('invariant 7 — a well-formed request is always 200', () => {
  it('rejects serving a report with a 4xx or 5xx', () => {
    const report = buildReport([
      unavailable({
        capability: 'blacklist.gsma',
        checkedAt: AT,
        coverage: coverage([]),
        reason: 'provider_timeout',
      }),
    ]);
    expect(() => assertStatusInvariant(200, report)).not.toThrow();
    expect(() => assertStatusInvariant(502, report)).toThrow(/even when every section is unavailable/);
  });
});

describe('the summary can never be greener than the sections', () => {
  it('derives undetermined when anything is unavailable', () => {
    const d = deriveVerdict([
      cleanBlacklist(),
      unavailable({
        capability: 'warranty.status',
        checkedAt: AT,
        coverage: coverage([]),
        reason: 'capability_not_supported_for_device',
      }),
    ]);
    expect(d.verdict).toBe('undetermined');
    expect(d.sections_unavailable).toEqual(['warranty.status']);
  });

  it('derives amber for an inconclusive and red for a fail', () => {
    expect(
      deriveVerdict([
        inconclusive({
          capability: 'blacklist.gsma',
          checkedAt: AT,
          coverage: coverage(),
          reason: 'unrecognised_provider_value',
          remedy: 'retry_later',
        }),
      ]).verdict,
    ).toBe('amber');

    expect(
      deriveVerdict([
        fail({
          capability: 'blacklist.gsma',
          checkedAt: AT,
          coverage: coverage(),
          evidence: [{ type: 'flag', label: 'Block-list entry', value: true }],
          finding: { key: 'blacklisted', severity: 'critical', summary: 'Reported lost or stolen.' },
        }),
      ]).verdict,
    ).toBe('red');
  });

  it('derives green only when every section passed', () => {
    expect(deriveVerdict([cleanBlacklist()]).verdict).toBe('green');
    expect(deriveVerdict([]).verdict).toBe('undetermined');
  });

  it('rejects a hand-set green summary hiding an unknown', () => {
    const report = buildReport([
      cleanBlacklist(),
      unavailable({
        capability: 'warranty.status',
        checkedAt: AT,
        coverage: coverage([]),
        reason: 'capability_not_supported_for_device',
      }),
    ]);
    report.summary.verdict = 'green';
    expect(() => assertEnvelopeInvariants(report)).toThrow(/never render as green/);
  });

  it('rejects an unavailable section missing from sections_unavailable', () => {
    // A client renders the rows it received; a buyer reads a missing row as "nothing wrong found".
    const report = buildReport([
      unavailable({
        capability: 'blacklist.gsma',
        checkedAt: AT,
        coverage: coverage([]),
        reason: 'circuit_open',
      }),
    ]);
    report.summary.sections_unavailable = [];
    expect(() => assertEnvelopeInvariants(report)).toThrow(/must be stated, not omitted/);
  });
});

describe('section constructors carry their optional fields', () => {
  it('passes freshness through when the answer came from cache', () => {
    // A cached answer must report the ORIGINAL checked_at plus a true age, or the freshness
    // promise is empty and a client cannot render an honest report.
    const s = pass({
      capability: 'blacklist.gsma',
      checkedAt: AT,
      coverage: coverage(),
      evidence: [{ type: 'flag', label: 'Block-list entry', value: false }],
      freshness: { cached: true, age_seconds: 1800, ttl_seconds: 3600 },
    });
    expect(s.freshness).toEqual({ cached: true, age_seconds: 1800, ttl_seconds: 3600 });
    expect(s.checked_at).toBe(AT.toISOString());
  });

  it('carries a finding reported_at and an unavailable detail when given', () => {
    const f = fail({
      capability: 'blacklist.gsma',
      checkedAt: AT,
      coverage: coverage(),
      evidence: [{ type: 'flag', label: 'Block-list entry', value: true }],
      finding: {
        key: 'blacklisted',
        severity: 'critical',
        summary: 'Reported lost or stolen.',
        reportedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
    expect(f.finding?.reported_at).toBe('2026-08-01T00:00:00.000Z');

    const u = unavailable({
      capability: 'warranty.status',
      checkedAt: AT,
      coverage: coverage([]),
      reason: 'capability_not_supported_for_device',
      detail: 'Purchase-date lookup exists for Apple only; this TAC is Samsung.',
      evidence: [{ type: 'text', label: 'Manufacturer', value: 'Samsung' }],
    });
    expect(u.detail).toContain('Apple only');
    expect(u.evidence).toHaveLength(1);
  });

  it('omits optional fields entirely rather than setting them undefined', () => {
    const s = pass({
      capability: 'identity.model',
      checkedAt: AT,
      coverage: coverage([]),
      evidence: [{ type: 'text', label: 'Model', value: 'iPhone 13' }],
    });
    expect(s).not.toHaveProperty('detail');
    expect(s).not.toHaveProperty('finding');
    expect(s).not.toHaveProperty('reason');
  });
});

describe('the envelope schema itself', () => {
  it('parses a well-formed report', () => {
    const report = buildReport([cleanBlacklist()]);
    expect(() => CheckReport.parse(report)).not.toThrow();
    expect(() => assertEnvelopeInvariants(report)).not.toThrow();
  });
});

function buildReport(sections: SectionResult[]) {
  const derived = deriveVerdict(sections);
  return CheckReport.parse({
    schema_version: SCHEMA_VERSION,
    check_id: 'chk_test',
    status: 'complete',
    subject: { imei_masked: '35•••••••••••76', tac: '35310411', luhn_valid: true },
    requested_at: AT.toISOString(),
    completed_at: AT.toISOString(),
    sections: Object.fromEntries(sections.map((s) => [s.capability, s])),
    summary: { verdict: derived.verdict, reasons: [], sections_unavailable: derived.sections_unavailable },
    billing: { credits_charged: 0, breakdown: [] },
    disclaimer: DISCLAIMER,
  });
}
