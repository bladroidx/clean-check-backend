import { INCONCLUSIVE_REASONS, type Reason } from './enums.js';
import type { CheckReport, SectionResult } from './envelope.js';

/**
 * The seven invariants.
 *
 * These are cross-field rules that a zod object schema cannot express, and they are the entire
 * reason the four arms mean anything. Ports of the Kotlin `require` blocks in
 * `check-this-phone/core/model/.../ProbeResult.kt`.
 *
 * Called from contract tests AND at runtime in non-production, because a guarantee that only holds
 * in CI is a guarantee that stops holding the first time someone ships past CI.
 */

export class InvariantViolation extends Error {
  constructor(
    readonly invariant: number,
    message: string,
  ) {
    super(`envelope invariant ${invariant}: ${message}`);
    this.name = 'InvariantViolation';
  }
}

const REASONS_MEANING_PROVIDER_ANSWERED: readonly Reason[] = INCONCLUSIVE_REASONS;

export function assertSectionInvariants(s: SectionResult): void {
  const where = `${s.capability}`;

  // 1. A pass or fail with no numbers behind it is indistinguishable from a check that silently
  //    did nothing. This is the defect the whole project exists to avoid.
  if ((s.outcome === 'pass' || s.outcome === 'fail') && s.evidence.length === 0) {
    throw new InvariantViolation(
      1,
      `${where} is '${s.outcome}' with no evidence. A ${s.outcome} carrying no measurement is ` +
        `indistinguishable from a check that silently did nothing.`,
    );
  }

  // 2. `fail` carries the finding; no other arm may.
  if (s.outcome === 'fail' && s.finding === undefined) {
    throw new InvariantViolation(2, `${where} is 'fail' with no finding`);
  }
  if (s.outcome !== 'fail' && s.finding !== undefined) {
    throw new InvariantViolation(2, `${where} is '${s.outcome}' but carries a finding`);
  }

  // 3. An inconclusive with no remedy is a dead end, and a dead end reads to a buyer exactly like
  //    a failure.
  if (s.outcome === 'inconclusive') {
    if (s.reason === undefined) throw new InvariantViolation(3, `${where} inconclusive with no reason`);
    if (s.remedy === undefined) throw new InvariantViolation(3, `${where} inconclusive with no remedy`);
    if (!REASONS_MEANING_PROVIDER_ANSWERED.includes(s.reason)) {
      throw new InvariantViolation(
        3,
        `${where} is inconclusive with reason '${s.reason}', which means we never obtained an ` +
          `answer -- that is 'unavailable'. "We asked and got a non-answer" is inconclusive; ` +
          `"we never got an answer" is unavailable.`,
      );
    }
  }

  // 4. `unavailable` states why, and never carries a finding.
  if (s.outcome === 'unavailable') {
    if (s.reason === undefined) throw new InvariantViolation(4, `${where} unavailable with no reason`);
    if (REASONS_MEANING_PROVIDER_ANSWERED.includes(s.reason)) {
      throw new InvariantViolation(
        4,
        `${where} is unavailable with reason '${s.reason}', which means the provider did answer ` +
          `-- that is 'inconclusive'.`,
      );
    }
  }

  // Remedy belongs only to the arm that can be acted on.
  if (s.outcome !== 'inconclusive' && s.remedy !== undefined) {
    throw new InvariantViolation(3, `${where} is '${s.outcome}' but carries a remedy`);
  }

  // 5. `checked_at` on all four arms -- on `unavailable` it is the proof we tried.
  if (!s.checked_at || Number.isNaN(Date.parse(s.checked_at))) {
    throw new InvariantViolation(5, `${where} has no valid checked_at`);
  }

  // 6. Coverage on all four arms. On `unavailable` it describes what a good answer WOULD have
  //    covered -- more honest than null, and it lets a client explain the gap.
  if (s.coverage === undefined || s.coverage === null) {
    throw new InvariantViolation(6, `${where} has no coverage`);
  }
  if (s.outcome === 'pass' && s.coverage.caveats.length === 0 && s.capability === 'blacklist.gsma') {
    throw new InvariantViolation(
      6,
      `${where} is a clean blacklist result with no caveats. A clean GSMA answer cannot see a ` +
        `handset stolen yesterday, nor one stolen where networks do not report; saying so is the ` +
        `difference between a true statement and a misleading one.`,
    );
  }
}

/**
 * Invariant 7 is about the transport, not the body: HTTP 200 whenever the request itself was
 * well-formed and authorised, even if every section is `unavailable`. A 5xx is indistinguishable
 * to a naive client from "nothing wrong found".
 */
export function assertStatusInvariant(httpStatus: number, report: CheckReport): void {
  if (httpStatus >= 400) {
    throw new InvariantViolation(
      7,
      `report ${report.check_id} served with HTTP ${httpStatus}. A well-formed, authorised ` +
        `request returns 200 even when every section is unavailable.`,
    );
  }
}

export function assertEnvelopeInvariants(report: CheckReport): void {
  for (const section of Object.values(report.sections)) {
    if (section !== undefined) assertSectionInvariants(section);
  }

  // The summary must not be greener than the sections justify.
  const sections = Object.values(report.sections).filter((s): s is SectionResult => s !== undefined);
  const anyFail = sections.some((s) => s.outcome === 'fail');
  const anyUnknown = sections.some((s) => s.outcome === 'inconclusive' || s.outcome === 'unavailable');

  if (report.summary.verdict === 'green' && (anyFail || anyUnknown)) {
    throw new InvariantViolation(
      6,
      `summary is 'green' while ${anyFail ? 'a section failed' : 'a section is unknown'}. ` +
        `An unknown must never render as green.`,
    );
  }
  if (anyFail && report.summary.verdict !== 'red') {
    throw new InvariantViolation(6, `a section failed but the summary is '${report.summary.verdict}'`);
  }

  // A section we could not answer is stated, never dropped.
  const unavailable = sections.filter((s) => s.outcome === 'unavailable').map((s) => s.capability);
  for (const cap of unavailable) {
    if (!report.summary.sections_unavailable.includes(cap)) {
      throw new InvariantViolation(
        6,
        `${cap} is unavailable but missing from summary.sections_unavailable. An answer we could ` +
          `not give must be stated, not omitted -- a client renders the rows it received, and a ` +
          `buyer reads a missing row as "nothing wrong found".`,
      );
    }
  }
}

/** Derive the summary verdict from the sections, so it cannot be set optimistically by hand. */
export function deriveVerdict(sections: readonly SectionResult[]): {
  verdict: 'green' | 'amber' | 'red' | 'undetermined';
  sections_unavailable: SectionResult['capability'][];
} {
  const sections_unavailable = sections
    .filter((s) => s.outcome === 'unavailable')
    .map((s) => s.capability);

  if (sections.some((s) => s.outcome === 'fail')) return { verdict: 'red', sections_unavailable };
  if (sections.length === 0) return { verdict: 'undetermined', sections_unavailable };
  if (sections.some((s) => s.outcome === 'unavailable')) {
    return { verdict: 'undetermined', sections_unavailable };
  }
  if (sections.some((s) => s.outcome === 'inconclusive')) {
    return { verdict: 'amber', sections_unavailable };
  }
  return { verdict: 'green', sections_unavailable };
}
