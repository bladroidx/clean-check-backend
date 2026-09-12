---
name: backend-quality-gate
description: Run the complete quality toolchain for imei-check — format, lint, typecheck, dependency-cruiser module boundaries, unit and integration tests, coverage, the sentinel IMEI leak scan, secret scan, OpenAPI compatibility diff, npm audit and unused-dependency check — then triage every finding. Use before a merge or release, in CI setup, or whenever a gate fails.
---

<role>
This skill is the full gate. Run stages cheapest-and-most-deterministic first and stop early on an
early failure — there is no point spending container minutes on code that does not typecheck.
</role>

<context>
Coverage floors: `packages/identity` 95% · `packages/contract` 90% · `packages/providers` 85% ·
`apps/api` 75% · everything else 60%. Identity is highest because it is pure, tiny and ported from
another language — there is no excuse and every reason.
</context>

<rules>
1. **Never make a gate pass by weakening it.** Lowering a threshold, disabling a rule, widening an
   ignore or adding a `skip` needs a human and an ADR — propose it, do not do it.
2. **Suppress narrowly**: the specific rule, on the specific line, with a why-comment.
3. **Coverage is a floor, not a goal.** Check *what* is covered: 100% of `pass` paths with no
   `unavailable` test is a failing suite reporting green.
4. **Any raw-IMEI or secret hit is a release blocker**, not a warning.
5. **An OpenAPI breaking change with no version bump is a blocker.**
6. **Never report a stage as passing that you did not run** — `NOT_RUN` with a reason is fine.
7. **`--force`, `--no-verify` and `.skip` in a committed test are findings**, always.
</rules>

<workflow>
Run in order. Stop and report if an early stage fails.
```bash
npx prettier --check .
npx eslint . --max-warnings 0
npm run typecheck                              # tsc --build --force
npx depcruise --validate .dependency-cruiser.cjs packages apps
npm test -- packages                           # unit: identity, contract, providers
npm test -- --coverage
npm run test:integration                       # testcontainers: migrations, ledger, routes
npm run test:sentinel                          # the IMEI leak scan — never skippable
npm -w @imei-check/contract run schema:emit && npm run schema:diff
npx knip                                       # unused files, exports, dependencies
npm audit --omit=dev
rg -n 'console\.(log|debug)' packages apps --glob '!**/*.test.ts'
rg -n 'api[_-]?key|apiaccesskey|secret|Bearer [A-Za-z0-9]{16,}|-----BEGIN' packages apps db
rg -n '\b\d{15}\b' packages apps db --glob '!**/fixtures/**' --glob '!testdata/**'
rg -n '\.skip\(|\.only\(|@ts-ignore|as unknown as' packages apps
```
Then triage every finding into exactly one bucket and act accordingly.
</workflow>

<examples>
<example name="triage-buckets">
1. **Real defect** → fix it, and add the test that would have caught it
2. **Real but out of scope** → report with `file:line` and severity; do not fix silently
3. **False positive** → suppress the specific rule on the specific line, with a why-comment.
   Never file-wide, never package-wide
4. **Pre-existing debt** → record the count so the trend is visible
</example>
<example name="grep-triage">
A `\d{15}` hit in `testdata/imei-vectors.json` is expected — those are the golden vectors and the
file is excluded. A hit in `docs/` or in an OpenAPI `example` is a blocker: a real IMEI pasted into
a sample response gets published. A hit in a fixture means the scrubber did not run — blocker.
</example>
<example name="the-coverage-question-that-matters">
`packages/providers` at 88% looks fine. Check which 12% is missing: if it is the `failed` and
`rejected` branches of every adapter, the number is meaningless. Report arms covered, not lines.
</example>
</examples>

<format_constraints>
```
QUALITY GATE — <sha>
PASS    <gates>
FAIL    <gate> — <n> errors
NOT_RUN <gate> — <reason>

Blocking (n)
 1. <file:line> — <rule> — <what> — FIXED / NOT FIXED: <why>
Non-blocking (n)
 <file:line> — <rule> — proposed, not applied

Coverage: <pkg> <n>% (floor <n>%) · arms pass/fail/inconclusive/unavailable <n>/<n>/<n>/<n>
Schema:   <additive|breaking> vs snapshots/<v>.json
Sentinel: <PASS|FAIL>
```
</format_constraints>
