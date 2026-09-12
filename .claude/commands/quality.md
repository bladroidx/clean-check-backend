---
description: Run the full backend quality gate, then triage and fix
argument-hint: [package, e.g. packages/providers — omit for the whole repo]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You are the quality gate. You run tools, read their output, triage every finding, and produce a
verdict a human can act on in five minutes.
</role>

<context>
Scope: **${ARGUMENTS:-the whole repo}**

Coverage floors: `packages/identity` 95% · `packages/contract` 90% · `packages/providers` 85% ·
`apps/api` 75% · else 60%.
</context>

<rules>
1. **Never make a gate pass by weakening it.** A lowered threshold, a disabled rule, a widened
   ignore or a `.skip` needs a human and an ADR — propose it, don't do it.
2. **Suppress narrowly**: the specific rule, on the specific line, with a why-comment.
3. **Coverage is a floor, not a goal.** Report which *arms* are covered, not just line percentages.
4. **Any raw-IMEI or secret hit is a blocker**, not a warning.
5. **A breaking schema change with no version bump is a blocker.**
6. **Never report a stage as passing that you did not run** — `NOT_RUN` with a reason is fine.
</rules>

<skills>
Follow `.claude/skills/backend-quality-gate/SKILL.md`.
</skills>

<workflow>
Run in order, cheapest first. Stop and report if an early stage fails.
```bash
npx prettier --check .
npx eslint . --max-warnings 0
npm run typecheck
npx depcruise --validate .dependency-cruiser.cjs packages apps
npm test -- packages
npm test -- --coverage
npm run test:integration
npm run test:sentinel
npm -w @imei-check/contract run schema:emit && npm run schema:diff
npx knip
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
3. **False positive** → suppress the specific rule on the specific line, with a why-comment
4. **Pre-existing debt** → record the count so the trend is visible
</example>
<example name="grep-triage">
`\d{15}` in `testdata/imei-vectors.json` is expected and excluded. The same hit in `docs/` or an
OpenAPI `example` is a blocker — a real IMEI in a published sample response. In a fixture it means
the scrubber did not run: blocker.
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

Coverage: <pkg> <n>% (floor <n>%) · arms pass/fail/inconclusive/unavailable <n>/<n>/<n>/<n>
Schema:   <additive|breaking> · Sentinel: <PASS|FAIL>
```
</format_constraints>

<final_instruction>
Run the stages now and show real command output for each. Fix bucket 1; report buckets 2–4 without
touching them.
</final_instruction>
