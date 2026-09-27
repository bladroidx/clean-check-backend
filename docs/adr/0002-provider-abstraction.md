# 0002 — Providers are abstracted, and adapters never build a section

**Status:** Accepted · 2026-09-12
**Applies to:** `packages/providers` (M1), `apps/api/src/report/assemble.ts`

## Context

We have no GSMA relationship. The lost/stolen answer is bought from resellers whose own access may
be irregular, who change response formats without notice, who go offline, and who are also our
competitors. Most speak one of two DHRU dialects; one day one of them will be replaced by GSMA
Device Check direct.

## Decision

A `Provider` interface with `catalogue()`, `supports()`, `execute()`, optional `poll()` and
`parseWebhook()`, and `health()`.

`execute()` returns a `ProviderOutcome` — `answered` | `pending` | `rejected` | `failed` — which is
**not** the public envelope. The conversion to a `SectionResult` happens in exactly one file,
`apps/api/src/report/assemble.ts`.

Capabilities come from a checked-in YAML catalogue keyed by service ID, never from parsing a
seller-authored service name.

**Failover happens on transport failure or an open circuit only — never after a definite negative
answer.**

## Alternatives rejected

**Let each adapter emit a `SectionResult` directly.** Rejected: it puts the power to emit `pass` in
fifteen files written against fifteen undocumented supplier formats. One choke point means the arm
selection is testable in isolation and no adapter can invent a fifth arm.

**Auto-map capabilities by parsing `SERVICENAME`.** Rejected: those strings are seller-authored
(`"🔥 iPhone GSX Full Info (FAST) 🔥"`) and change for marketing reasons.

**Failover until a provider answers.** Rejected as a fraud vector: if provider A says "blacklisted"
and we shop for one who says clean, a reseller with an API key simply retries until green.

## Consequences

- Adding a provider is mostly data (a YAML catalogue and fixtures) plus a normalisation table.
- A single-sourced capability is a business risk, not just a technical one. Two providers per paid
  capability before launch.
- The catalogue duplicates upstream state and will drift, so a nightly drift job that auto-disables
  a repriced service is mandatory, not optional. (Implemented 2026-09-27:
  `apps/worker/src/jobs/catalogue-drift.ts` writes `provider_service_overrides`, which
  `GuardedProvider` checks before every purchase; `reconcile-balance.ts` compares the real
  `accountinfo` balance against recorded spend. A human lifts an override with
  `npm run service:override`.)

## Enforcement

- `.dependency-cruiser.cjs` keeps `providers` from importing `apps/`.
- Contract tests assert only `assemble.ts` constructs a `SectionResult`.
- Per-provider 15-case fixture matrix; see `.claude/skills/provider-adapter-authoring/SKILL.md`.

## Amended 2026-09-25

The operator chose imei24 (pro.imei24.com, over the existing `DhruLegacyProvider`) as the **sole**
paid supplier for the free-`/v1/checks`-plus-paid-`/v1/deep_checks` phase — see
`docs/superpowers/specs/2026-09-25-deep-checks-imei24-design.md` §1 ("imei24 is the only upstream.
Suppliers `alpha` and `beta` are removed."). The "two providers per paid capability" consequence
above is therefore relaxed to **at least one enabled service per claimed capability** for the
duration of this phase: `packages/providers/test/catalogue.test.ts`'s "every claimed capability is
backed by at least one enabled service" test enforces the relaxed form.

This is a deliberate, temporary trade, not a retraction of the underlying risk: a single-sourced
capability is still a business risk. The `>=2` gate must be restored the moment a second provider's
catalogue is added.
