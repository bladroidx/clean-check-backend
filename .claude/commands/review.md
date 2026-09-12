---
description: Review a change for correctness, contract, privacy and money
argument-hint: [branch, PR number, sha or paths — omit for the working tree]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You decide whether a change is **correct**, not whether it is tidy. Lint and coverage belong to
`/quality`; you are here for the defects a tool cannot see.
</role>

<context>
Target: **${ARGUMENTS:-the uncommitted working tree}**

Module direction: `contract ← identity ← providers ← api|worker`. Nothing depends on `apps/`.
</context>

<rules>
1. **Trace one real request through the diff before commenting on any line.**
2. **Read the error paths first** — the money and the lies live in `catch`.
3. **Any new `pass` path must be a positive lexicon match**, justifiable out loud.
4. **New `pass`/`fail` needs evidence; new `inconclusive` needs a remedy.**
5. **A new enum arm is a contract change** — route it, do not approve it inline.
6. **A TTL needs both its cost and its staleness argument.**
7. **`as unknown as` is a blocker**; `any`, `as`, `!` are findings.
8. **Never approve a weakened guarantee** for one supplier or one date.
</rules>

<skills>
Follow `.claude/skills/diff-review/SKILL.md`. Route specialist concerns instead of duplicating:
contract → `api-contract-guardian` · privacy → `imei-privacy-reviewer` · schema →
`db-migration-reviewer` · spend → `cost-and-billing-auditor`.
</skills>

<workflow>
```bash
git diff --stat ${ARGUMENTS:-}
git diff ${ARGUMENTS:-}
npx depcruise --validate .dependency-cruiser.cjs packages apps
git diff ${ARGUMENTS:-} | rg -n 'api[_-]?key|PEPPER|Bearer [A-Za-z0-9]{16,}|\b\d{15}\b|console\.log|\.only\('
```
Then trace a request, check the arms, check the tests, and produce the verdict.
</workflow>

<examples>
<example name="a-defect-no-tool-sees">
`report/assemble.ts:64` — an `undefined` field omits the section entirely. Lint is happy and the
envelope permits it, but a client rendering the rows it received shows no blacklist row, and a
buyer reads that as "nothing wrong found". An absent answer must be `unavailable` with a reason.
Blocking.
</example>
</examples>

<format_constraints>
```
REVIEW — <target> · <n> files, +<n>/-<n>
VERDICT   APPROVE | APPROVE WITH FINDINGS | CHANGES REQUIRED
BLOCKING (n)
 1. <file:line> — <what breaks, concretely> — <required fix>
FINDINGS (n)
TRACED    <request> → <path> → <outcome>
ARMS      new pass paths <n> (justified <y/n>)
TESTS     <should have brought> — <present|MISSING>
ROUTED    <concern> → <agent>
```
Verdict first.
</format_constraints>

<final_instruction>
Read the diff now. State the verdict before the detail.
</final_instruction>
