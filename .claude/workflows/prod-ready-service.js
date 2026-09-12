export const meta = {
  name: 'prod-ready-service',
  description:
    'Assess whether imei-check is fit to take real money and real IMEIs — auditing the honesty contract, provider resilience, privacy and GDPR posture, the money path, security and abuse controls, operability, and cross-repo consistency with the Check This Phone app — then adversarially verify every launch blocker and produce a go/no-go.',
  phases: [
    { title: 'Audit', detail: 'Six independent audits of the dimensions that decide launch' },
    { title: 'Verify', detail: 'Adversarial re-check of every claimed launch blocker' },
    { title: 'Decide', detail: 'A single go/no-go with the shortest path to go' },
  ],
}

// Agent budget: 6 audits + up to 6 verifications + 1 decision = at most 13 agents.
const MAX_VERIFICATIONS_PER_AUDIT = 1

const MILESTONE = (args && args.milestone) || 'M1 — first paid capability'

const CONTEXT = `
Project: imei-check — a provider-agnostic IMEI reputation API (Node + TypeScript + Fastify 5 +
Postgres) that resells grey-market IMEI data. It is also the backend the Android app at
../check-this-phone defers to in its PLAN.md Phase 6.

Read first: CLAUDE.md, docs/adr/, and /home/hero/.claude/plans/i-want-to-create-vivid-turing.md

Milestone under assessment: ${MILESTONE}

## What "production ready" means HERE, specifically

This is not a generic readiness review. Three failures would end this product, and they are the
lens for everything:

 1. A stolen phone reported as clean. The data is bought from unreliable suppliers whose wording
    changes without notice, so the failure mode is silent, not loud.
 2. A raw IMEI stored, logged or leaked. IMEI is personal data; this is a trust product, and a
    quiet leak here contradicts the thing being sold.
 3. Spending more upstream than we charge, without noticing. Margin is essentially one number
    (cache-hit rate) and a supplier can reprice at any time.

A finding is a LAUNCH BLOCKER only if it enables one of those three, or if it breaks a promise
already made to a paying customer or a shipped client. Everything else is a finding with a
priority. Be strict about that distinction — a review where everything is a blocker is a review
nobody can act on.

Judge what EXISTS. Read the code and run the commands. A design documented in an ADR but not
implemented is NOT_IMPLEMENTED, never PASS. Quote file:line for every claim.
`.trim()

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['dimension', 'readiness', 'findings'],
  properties: {
    dimension: { type: 'string' },
    readiness: { type: 'string', enum: ['READY', 'READY_WITH_RISK', 'NOT_READY', 'NOT_IMPLEMENTED'] },
    evidence: { type: 'array', items: { type: 'string' } },
    commandsRun: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'launchBlocker', 'file'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          launchBlocker: { type: 'boolean' },
          failureScenario: { type: 'string' },
          remediation: { type: 'string' },
          effort: { type: 'string', enum: ['hours', 'days', 'weeks'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'isLaunchBlocker', 'reasoning'],
  properties: {
    isReal: { type: 'boolean' },
    isLaunchBlocker: { type: 'boolean' },
    reasoning: { type: 'string' },
    correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  },
}

const AUDITS = [
  {
    key: 'honesty',
    title: 'The honesty contract — can an unknown render as a pass?',
    prompt: `
This is the most important audit. Trace every path that can produce outcome 'pass' and prove each
one requires a POSITIVE lexicon match.

Check specifically:
 - lexicon.ts: does an unrecognised value return undefined, and does assemble.ts turn that into
   inconclusive(unrecognised_provider_value)? Or does it omit the section, or default benign?
 - An OMITTED section is as dangerous as a wrong one: a client rendering the rows it received shows
   a report with no blacklist row, and a buyer reads that as "nothing wrong found".
 - Per-field polarity: 'ON' is bad for blacklist and good for nothing; 'OFF' is good for
   activation_lock. A global boolean lexicon gets activation_lock backwards.
 - Failover: is failover after a DEFINITE NEGATIVE answer blocked? If provider A says blacklisted
   and the router retries into B, that is a fraud vector.
 - The seven envelope invariants in .claude/skills/four-arm-contract/SKILL.md — does each have an
   assertion, and does assertEnvelopeInvariants run in production, not only in tests?
 - coverage.caveats: present and non-empty on blacklist? A "clean" with no caveat is a misleading
   true statement.

Run the tests. Grep for the assertion that unrecognised values map to inconclusive.`,
  },
  {
    key: 'suppliers',
    title: 'Provider resilience — what happens when a supplier misbehaves',
    prompt: `
Suppliers are grey-market, unstable, and also our competitors. Audit:
 - Fixture matrix completeness per provider/service (15 cases). Missing waf-html-200,
   success-wrapping-error or unrecognised-status is serious.
 - Circuit breaker present and wired; per-attempt timeout = sla.p95_ms * 1.5, ceiling 30s.
 - At least TWO providers per paid capability. A single-sourced capability is a single point of
   business failure, not just a technical one.
 - Async lifecycle: pending -> provider_orders -> webhook AND poller (webhook must never be the
   only path) -> hard 24h expiry that RELEASES the reservation. An order with no expiry leaks the
   reservation pool.
 - Catalogue drift job: exists, runs, and AUTO-DISABLES a repriced service. Check when it last ran.
 - imei_lexicon_miss_total metric exists and has an alert — it is the leading indicator that a
   supplier reworded something.`,
  },
  {
    key: 'privacy',
    title: 'Privacy and GDPR posture',
    prompt: `
Execute .claude/skills/imei-privacy/SKILL.md end to end, all 8 steps, and run the sentinel test.

Beyond the code, assess the posture a regulator or a B2B buyer would ask about:
 - Lawful basis stated and a written LIA for fraud prevention?
 - A DPA with EVERY provider, and a transfer mechanism (these suppliers are largely outside the
   EEA)?
 - Retention published and actually implemented as partition drops?
 - DSAR answerable by recomputing the hash?
 - Does any document claim the data is "anonymous"? We hold a keyed hash AND a lookup log, so it is
   pseudonymised personal data, in scope. Challenge any doc that oversells this.
 - Cross-repo: ../check-this-phone/docs/adr/0006 forbids IMEI in telemetry even hashed and asserts
   zero network calls with telemetry off. Is this API documented as a SEPARATE purpose-limited
   egress, and has that ADR's zero-call assertion been rescoped? If not, the app's test suite will
   go green while meaning nothing.`,
  },
  {
    key: 'money',
    title: 'The money path',
    prompt: `
Execute .claude/skills/credits-and-billing/SKILL.md. Verify against the charge matrix:
 - Nothing charged for unavailable, nor for inconclusive(unrecognised_provider_value).
 - Failover legs absorbed, not charged; is the absorbed/revenue ratio instrumented?
 - provider_calls row written BEFORE the HTTP call. If it is written only on success, the books are
   permanently behind reality, because a timeout after the provider already debited us is the
   common case.
 - credit_ledger append-only ENFORCED (trigger or revoked grant), not merely conventional.
 - SUM(delta) = balance asserted by a job that pages.
 - Reserve/settle two-phase, with release on completion, rejection and expiry.
 - Insufficient balance DEGRADES to unavailable(insufficient_credits) per capability rather than
   402-ing the whole check.
 - warranty.status derived from cached immutable purchase_date, not re-looked-up.
 - Reconciliation against the provider's own accountinfo.
Report unit economics per capability if the data exists; say so plainly if it does not.`,
  },
  {
    key: 'security',
    title: 'Security and abuse — enumeration is a financial control',
    prompt: `
Audit auth, limits and abuse:
 - Key generation entropy, sha256+prefix storage (argon2 here is WRONG and not a finding),
   constant-time comparison, revocation, scopes.
 - Idempotency-Key REQUIRED on POST /v1/checks, fingerprinted, 409 on mismatch.
 - THREE independent limits: request rate; per-tenant in-flight PAID CONCURRENCY; daily
   distinct-IMEI quota. The concurrency cap is what stops a client retry loop draining the provider
   balance in ninety seconds — its absence is a launch blocker at any real traffic.
 - Enumeration detection via TAC-bucket coverage, and the response ladder ending in
   serve-cache-only before suspension.
 - imc_test_ keys provably incapable of live spend — an assertion, not a code path someone trusts.
 - Inbound provider webhooks: signature verified, reference_id bound to a check we created.
 - Secrets absent from repo, image, logs and error bodies; config refuses a weak SERVER_PEPPER.
Run a synthetic enumeration sweep if the code supports it and report whether spend was zero.`,
  },
  {
    key: 'operability',
    title: 'Operability — can this be run at 3am by someone who did not build it',
    prompt: `
Assess:
 - /readyz semantics: fails on DB down or migrations behind, and does NOT fail when a provider is
   down. Getting that wrong restarts healthy pods during someone else's incident — treat a provider
   check inside readiness as a launch blocker.
 - Migrations run as a separate init step, never on app boot.
 - The named metrics exist, and each has a panel or an alert that reads it.
 - Alerts have runbook lines naming the action, and there is an alert on the ABSENCE of a job, not
   only on its failure — a drift detector that stopped 19 days ago produces no failures at all.
 - Provider credit balance monitored with a 3-day-of-burn alert. Running out upstream degrades
   every paid capability to unavailable at once.
 - Config validated at boot with the full list of what is missing.
 - Docker image non-root; one image with CMD selecting api|worker.
 - Can a new operator answer "why did check X return unavailable" from the evidence log alone?`,
  },
]

const results = await pipeline(
  AUDITS,
  (a) =>
    agent(
      `${CONTEXT}\n\n## Your audit: ${a.title}\n${a.prompt}\n\nReturn the structured result.`,
      { label: `audit:${a.key}`, phase: 'Audit', schema: AUDIT_SCHEMA },
    ),
  (audit) => {
    const blockers = (audit.findings || [])
      .filter((f) => f.launchBlocker)
      .sort((x, y) => (x.severity === 'critical' ? -1 : 1))
      .slice(0, MAX_VERIFICATIONS_PER_AUDIT)
    return parallel(
      blockers.map((f) => () =>
        agent(
          `${CONTEXT}

Adversarially verify this claimed LAUNCH BLOCKER from the ${audit.dimension} audit. Assume it is
overstated until the code says otherwise.

  title:    ${f.title}
  file:     ${f.file}${f.line ? ':' + f.line : ''}
  scenario: ${f.failureScenario || '-'}
  severity: ${f.severity}

Read the actual file and run the actual command. Decide two things separately:
 1. Is the defect REAL, or did the audit misread the code?
 2. Even if real, is it a LAUNCH BLOCKER by this project's definition — does it enable a stolen
    phone reading clean, an IMEI leak, or unnoticed negative margin, or break a promise already
    made to a paying customer or a shipped client? If not, it is a prioritised finding, not a
    blocker. Say so.

Do not fix anything. Return the verdict.`,
          { label: `verify:${audit.dimension}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((v) => ({ ...f, dimension: audit.dimension, verdict: v })),
      ),
    )
  },
)

const audits = results.map((r) => r).flat().filter(Boolean)
const confirmed = audits.filter((f) => f.verdict?.isReal && f.verdict?.isLaunchBlocker)
const downgraded = audits.filter((f) => f.verdict?.isReal && !f.verdict?.isLaunchBlocker)
const rejected = audits.filter((f) => !f.verdict?.isReal)

await phase('Decide')

const decision = await agent(
  `${CONTEXT}

The six audits are complete and every claimed launch blocker has been adversarially verified.

CONFIRMED LAUNCH BLOCKERS (${confirmed.length}):
${JSON.stringify(confirmed.map((f) => ({ dimension: f.dimension, title: f.title, file: f.file, effort: f.effort, remediation: f.remediation })), null, 2)}

DOWNGRADED — real, but not launch blockers (${downgraded.length}):
${JSON.stringify(downgraded.map((f) => ({ title: f.title, why: f.verdict.reasoning })), null, 2)}

REJECTED — not real (${rejected.length}):
${JSON.stringify(rejected.map((f) => ({ title: f.title, why: f.verdict.reasoning })), null, 2)}

Produce the go/no-go for ${MILESTONE}. Requirements:
 - Lead with GO or NO-GO. Do not bury it.
 - If NO-GO, give the SHORTEST path to GO: the ordered list of blockers with effort, and what can
   run in parallel. A no-go with no path is a complaint.
 - Say explicitly what risk a GO would be accepting. There is always some; naming it is the point.
 - Do not pad the blocker list to look thorough. If the honesty contract holds, the IMEIs do not
   leak and the margin is instrumented, say so plainly.`,
  { label: 'decision', phase: 'Decide' },
)

return {
  milestone: MILESTONE,
  verdict: confirmed.length === 0 ? 'GO' : 'NO-GO',
  confirmedBlockers: confirmed,
  downgraded,
  rejected: rejected.map((f) => ({ title: f.title, why: f.verdict?.reasoning })),
  decision,
}
