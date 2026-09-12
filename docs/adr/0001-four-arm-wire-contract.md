# 0001 — Four arms on the wire, and no boolean verdict

**Status:** Accepted · 2026-09-12
**Applies to:** `packages/contract`, every route, every provider adapter

## Context

The obvious API for this product returns `{"clean": true}`. Every competitor does something close
to it, and every integrator asks for it.

We resell grey-market data. The upstream answer can be stale, reworded, missing, or absent because
a supplier's WAF returned an HTML page with HTTP 200. The question "is this phone clean?" therefore
has four honest answers, not two, and the difference between them is the product.

The Android app at `../check-this-phone` already solved this problem for hardware probes: its
`ProbeResult` has four arms and its `CLAUDE.md` states *"`Unavailable` is never an error and never
silently a `pass`"*.

## Decision

Every section of every response is exactly one of `pass` · `fail` · `inconclusive` · `unavailable`,
mirroring `ProbeResult` so the Kotlin client deserialises into its own sealed type.

Seven invariants, enforced by `assertEnvelopeInvariants()` at runtime outside production and in
contract tests always:

1. `pass` and `fail` carry non-empty `evidence`.
2. `fail` carries `finding`; no other arm may.
3. `inconclusive` carries both `reason` and `remedy`.
4. `unavailable` carries `reason`, never `finding`.
5. `checked_at` on all four arms — on `unavailable` it is the proof we tried.
6. `coverage` on all four arms — on `unavailable` it says what a good answer *would* have covered.
7. HTTP 200 whenever the request was well-formed and authorised, even if every section is
   `unavailable`.

The boundary between the two "we don't know" arms: **"we asked and got a non-answer" is
`inconclusive`; "we never got an answer" is `unavailable`.**

There is no top-level boolean. `summary.verdict` is `green | amber | red | undetermined`, derived
from the sections by `deriveVerdict()` rather than set by hand, and always with reasons.

## Alternatives rejected

**A boolean `clean` field, with the detail alongside.** Rejected: integrators would read the
boolean and ignore the detail, which is the entire failure mode. A wrong `true` helps sell stolen
goods; a wrong `false` defames a seller. There is no value of the boolean that is safe when we do
not know.

**Omitting a section we could not answer.** Rejected, and specifically guarded against: a client
renders the rows it received, and a buyer reads a missing row as "nothing wrong found". Absence
must be stated.

**5xx on provider failure.** Rejected: to a naive client a 502 is indistinguishable from "nothing
wrong found", and it also makes provider outages look like our outages to every uptime monitor.

## Consequences

- Integration is harder. A client must handle four arms and render `coverage`. We accept that; it
  is the product.
- `deriveVerdict` can never be greener than its sections, so a single `unavailable` downgrades the
  whole report to `undetermined`. That is intended and will occasionally annoy customers.
- Adding an enum arm later is a **breaking** change, because the Kotlin client's `when` is
  exhaustive and fails closed. See `.claude/skills/api-versioning/SKILL.md`.

## Enforcement

- `packages/contract/src/invariants.ts`, called from routes and from
  `packages/contract/test/invariants.test.ts` (19 tests, one per invariant plus the boundary cases).
- `apps/api/test/routes.test.ts` asserts every served section passes `assertSectionInvariants`.
