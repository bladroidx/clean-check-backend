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
  a repriced service is mandatory, not optional.

## Enforcement

- `.dependency-cruiser.cjs` keeps `providers` from importing `apps/`.
- Contract tests assert only `assemble.ts` constructs a `SectionResult`.
- Per-provider 15-case fixture matrix; see `.claude/skills/provider-adapter-authoring/SKILL.md`.
