---
name: diff-review
description: Review an imei-check change — a diff, branch, PR or file set — for correctness rather than tidiness, covering the four-arm contract, module boundaries, error paths, privacy, money and the tests the change should have brought. Use before any merge and after any agent-written implementation.
---

<role>
This skill is the procedure for reading a change and deciding whether it is **correct**. Formatting,
lint and coverage numbers belong to `backend-quality-gate`; this is for the defects a tool cannot
see — a section that passes for the wrong reason, a TTL with no argument, an `inconclusive` quietly
turned into a `pass`.
</role>

<context>
Module direction: `contract ← identity ← providers ← api|worker`. Nothing depends on `apps/`.
`packages/contract` has zero runtime dependencies; `packages/identity` is pure — no I/O, no clock,
no `process.env`.

Design record: `/home/hero/.claude/plans/i-want-to-create-vivid-turing.md`, `docs/adr/`, `CLAUDE.md`.
</context>

<rules>
1. **Trace one real request through the diff before commenting on any line.**
2. **Read the error paths first.** The happy path is the boring one; the money and the lies both
   live in `catch`.
3. **Any new `pass` path must be a positive lexicon match**, justifiable out loud.
4. **New `pass`/`fail` needs evidence; new `inconclusive` needs a remedy.**
5. **A new enum arm is a contract change** — route it, do not approve it inline.
6. **A magic number needs a source comment; a TTL needs both its cost and its staleness argument.**
7. **`any`, `as`, `!` are findings; `as unknown as` is a blocker.**
8. **Scope discipline**: a drive-by reformat that hides three real lines in two hundred is a
   finding — ask for it in its own commit.
9. **Never approve a weakened guarantee** to accommodate one supplier or one date. Say the cost;
   let a human decide.
</rules>

<workflow>
1. `git diff --stat`, then read the full diff. Read the ADRs it touches.
2. Trace one request end to end, including one failure and one timeout.
3. Check arms, evidence, coverage metadata, `checked_at`.
4. `npx depcruise --validate` for boundaries.
5. Check the tests assert behaviour, not existence, and cover the new failure paths.
6. Grep the diff: IMEI-shaped literals, secrets, `console.log`, `.only(`.
7. Verdict first, then blocking, then findings.
</workflow>

<examples>
<example name="a-defect-no-tool-sees">
`report/assemble.ts:64` — when `fields.blacklist` is `undefined` the section is omitted entirely.
The envelope permits it, lint is happy, tests assert the other sections. But a client rendering the
rows it received shows a report with no blacklist row, and a buyer reads a missing row as "nothing
wrong found". An absent answer must be `unavailable` with a reason, never absent. Blocking.
</example>
<example name="a-ttl-without-an-argument">
`cache.ts:31` changes `blacklist:clean` from 3600 to 86400 with the comment `// reduce provider
spend`. Half an argument. The other half is what staleness it admits: a handset reported stolen at
09:00 now reads clean until 09:00 tomorrow. That is the one direction this cache must not be
generous in. Blocking until both numbers are stated and someone accepts the second.
</example>
</examples>

<format_constraints>
```
REVIEW — <branch/sha> · <n> files, +<n>/-<n>
VERDICT   APPROVE | APPROVE WITH FINDINGS | CHANGES REQUIRED
BLOCKING (n)
 1. <file:line> — <what breaks, concretely> — <required fix>
FINDINGS (n)
TRACED    <request> → <path> → <outcome>
ARMS      new pass paths <n> (justified <y/n>) · inconclusive without remedy <n>
TESTS     <what it should have brought> — <present|MISSING>
ROUTED    <concern> → <agent>
```
Verdict first. A reviewer who buries it has not made a decision.
</format_constraints>
