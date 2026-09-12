export const meta = {
  name: 'quality-gate',
  description:
    'Run the full imei-check backend quality toolchain in parallel lanes — format/lint/types, module boundaries, tests and coverage, the IMEI leak sweep, schema compatibility and dependency health — then adversarially verify every blocking finding before reporting.',
  phases: [
    { title: 'Gates', detail: 'Five quality lanes run in parallel, each triaging its own findings' },
    { title: 'Verify', detail: 'Adversarial re-check of every blocking finding before it is reported' },
  ],
}

// Agent budget: 5 lanes + up to 4 verifications = at most 9 agents.
const MAX_VERIFICATIONS = 4

const SCOPE = (args && args.scope) || 'the whole repo'

const CONTEXT = `
Project: imei-check — a provider-agnostic IMEI reputation API (Node + TypeScript + Fastify 5 +
Postgres). Read CLAUDE.md and .claude/skills/backend-quality-gate/SKILL.md before starting.

Scope for this run: ${SCOPE}

The product's whole value is that a "pass" means something. Two classes of finding outrank
everything else:
  - anything that lets an unknown render as a pass (lexicon fallthrough, an omitted section,
    a failover after a definite negative answer)
  - anything that puts a raw IMEI or a secret somewhere durable

Triage every finding into exactly one bucket:
 1. Real defect        → fix it, and add the test that would have caught it
 2. Real, out of scope → report with file:line and severity; do NOT fix silently
 3. False positive     → suppress the SPECIFIC rule on the SPECIFIC line with a why-comment.
                         Never file-wide, never package-wide, never a blanket eslint-disable
 4. Pre-existing debt  → record the current count so the trend shows

NEVER make a gate pass by weakening it. Lowering a coverage floor, disabling a rule, widening an
ignore, adding .skip or setting --max-warnings higher needs a human and an ADR — propose it, do
not do it.

Report the REAL command output. A stage you did not run is NOT_RUN with a reason, never PASS.
`.trim()

const GATE_SCHEMA = {
  type: 'object',
  required: ['gate', 'status', 'findings'],
  properties: {
    gate: { type: 'string' },
    status: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_RUN'] },
    commands: { type: 'array', items: { type: 'string' } },
    notRunReason: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'summary', 'severity', 'blocking'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          rule: { type: 'string' },
          summary: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          blocking: { type: 'boolean' },
          bucket: { type: 'number' },
          fixed: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    metrics: { type: 'object' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reasoning'],
  properties: {
    isReal: { type: 'boolean' },
    reasoning: { type: 'string' },
    correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    stillBlocking: { type: 'boolean' },
  },
}

const LANES = [
  {
    key: 'static',
    title: 'Format, lint, types and module boundaries',
    prompt: `
Run and triage:
  npx prettier --check .
  npx eslint . --max-warnings 0
  npm run typecheck
  npx depcruise --validate .dependency-cruiser.cjs packages apps
  rg -n '\\.skip\\(|\\.only\\(|@ts-ignore|as unknown as' packages apps

A dependency-cruiser violation is BLOCKING: the module direction
(contract <- identity <- providers <- api|worker, nothing depends on apps/) is the analogue of the
Android app's ModuleBoundaryTest and is not negotiable. 'as unknown as' is blocking; a bare 'any',
'as' or '!' is a finding needing a why-comment.`,
  },
  {
    key: 'tests',
    title: 'Tests, coverage and which arms are actually covered',
    prompt: `
Run and triage:
  npm test -- packages
  npm test -- --coverage
  npm run test:integration

Coverage floors: packages/identity 95% - contract 90% - providers 85% - apps/api 75% - else 60%.

Coverage is a FLOOR, not a goal. The number is secondary to WHICH arms are covered. Report counts
of tests asserting each of pass / fail / inconclusive / unavailable. A package at 90% whose missing
10% is every adapter's failed and rejected branch is a failing suite reporting green — report that
as BLOCKING regardless of the percentage.

Also verify every provider has its 15-case fixture matrix, and that the
'unrecognised value maps to inconclusive, not pass' test exists for each. A missing one of those is
blocking: it is the assertion the product rests on.`,
  },
  {
    key: 'privacy',
    title: 'IMEI leak sweep and secrets',
    prompt: `
Execute .claude/skills/imei-privacy/SKILL.md steps 1-5, then:
  npm run test:sentinel
  rg -n -i 'imei' db/migrations/ | rg -v 'imei_hash|imei_masked|imei_hash_version'
  rg -n '\\b\\d{15}\\b' packages apps db docs --glob '!**/fixtures/**' --glob '!testdata/**'
  rg -n 'api[_-]?key|apiaccesskey|PEPPER|SALT|Bearer [A-Za-z0-9]{16,}|-----BEGIN' packages apps db docs
  rg -n 'saltedHash' packages apps

EVERY hit here is BLOCKING unless it is in testdata/ or a scrubbed fixture. A 15-digit number in
docs/ or in an OpenAPI example is a real leak - examples are published output. A saltedHash call
outside a test is blocking: server-side keys use HMAC.`,
  },
  {
    key: 'contract',
    title: 'Schema compatibility and envelope invariants',
    prompt: `
Run:
  npm -w @imei-check/contract run schema:emit
  npm run schema:diff
  npm test -- contract

Classify every schema delta with .claude/skills/api-versioning/SKILL.md. A NEW ENUM ARM is
BREAKING - the shipped Kotlin client's 'when' is exhaustive and fails closed on an unknown value.
A breaking change with no version bump and no Sunset plan is BLOCKING.

Then verify all seven envelope invariants still have an assertion behind them
(.claude/skills/four-arm-contract/SKILL.md). An invariant with no test is UNGUARDED - report it as
blocking even though nothing is currently failing.`,
  },
  {
    key: 'supply',
    title: 'Dependency health, unused code and audit',
    prompt: `
Run and triage:
  npx knip
  npm audit --omit=dev
  rg -n 'console\\.(log|debug)' packages apps --glob '!**/*.test.ts'

A high or critical advisory in a runtime dependency is blocking. An unused export in
packages/contract is worth reporting - dead schema is schema someone will resurrect wrongly.
A console.log in shipping code is a finding and a potential leak route: check what it prints.`,
  },
]

const results = await pipeline(
  LANES,
  (lane) =>
    agent(
      `${CONTEXT}\n\n## Your lane: ${lane.title}\n${lane.prompt}\n\nReturn the structured result.`,
      { label: `gate:${lane.key}`, phase: 'Gates', schema: GATE_SCHEMA },
    ),
  (gate) => {
    const blocking = (gate.findings || []).filter((f) => f.blocking).slice(0, MAX_VERIFICATIONS)
    return parallel(
      blocking.map((f) => () =>
        agent(
          `${CONTEXT}

Adversarially verify this claimed BLOCKING finding from the ${gate.gate} lane. Assume it is wrong
until the evidence says otherwise.

  file:     ${f.file}${f.line ? ':' + f.line : ''}
  rule:     ${f.rule || '-'}
  claim:    ${f.summary}
  evidence: ${f.evidence || '-'}

Read the actual file. Run the actual command. Decide:
 - Is the defect real, or did the lane misread the output?
 - Is it genuinely blocking, or a finding dressed up as one?
 - For a privacy hit: is the match in testdata/ or a scrubbed fixture (then it is not real)?
 - For a coverage claim: are the uncovered lines genuinely the failure arms?

Do not fix anything. Return the verdict.`,
          { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((v) => ({ ...f, gate: gate.gate, verdict: v })),
      ),
    )
  },
)

const verified = results.flat().filter(Boolean)
const confirmed = verified.filter((f) => f.verdict?.isReal && f.verdict?.stillBlocking !== false)
const rejected = verified.filter((f) => !f.verdict?.isReal)

return {
  scope: SCOPE,
  confirmedBlockers: confirmed,
  rejectedClaims: rejected.map((f) => ({ file: f.file, claim: f.summary, why: f.verdict?.reasoning })),
  verdict: confirmed.length === 0 ? 'PASS' : 'BLOCKED',
}
