# imei-check — contract summary

A provider-agnostic HTTP API that answers *"is this phone clean?"* from an IMEI. Node + TypeScript
+ Fastify 5 + Postgres. This service is the backend that `../check-this-phone` (the Android app)
defers to in its `PLAN.md` Phase 6 — and it is sellable to any other client.

Full design: `/home/hero/.claude/plans/i-want-to-create-vivid-turing.md`. ADRs in `docs/adr/`.

## The one thing that matters

**We resell grey-market data. Our product is honesty about it.**

The lost/stolen answer comes from the GSMA Device Registry, which is sold under contract to
operators, manufacturers, insurers and inventory managers. We are downstream of resellers. We
therefore cannot compete on data — we compete on a stable schema, on `coverage` metadata that says
what an answer actually covers, and on never turning "we don't know" into "it's fine".

## The four-arm contract

Every section of every response is exactly one of `pass` · `fail` · `inconclusive` · `unavailable`,
mirroring `ProbeResult` in the Android app so it deserialises natively.

1. **`unavailable` is never an error and never silently a `pass`.**
2. **`inconclusive` is not `fail`.** It carries a mandatory `remedy`; without one it reads to a
   buyer exactly like a failure.
3. **Evidence on every arm, `pass` included.** A `pass` with nothing behind it is indistinguishable
   from a check that silently did nothing.
4. **`coverage` and `checked_at` on every arm**, `unavailable` included — on that arm `coverage`
   describes what a successful answer *would* have covered.
5. **HTTP 200 whenever the request was well-formed and authorised**, even if every section is
   `unavailable`. 4xx/5xx are our faults only. A 502 is indistinguishable to a naive client from
   "nothing wrong found".
6. **There is no top-level `"clean": true`.** The summary is `green|amber|red|undetermined` with
   reasons. A wrong boolean either facilitates the sale of stolen goods or defames a seller.

## The parsing rule

**Absence of the word "blacklisted" is not proof of clean.** A section may only be `pass` on a
*positive* match against a known-good phrase in the lexicon for that provider and service. An
unrecognised value is `inconclusive(unrecognised_provider_value)` and increments
`imei_lexicon_miss_total`. Never a benign default. This is the line of code the product rests on:
without it, the day a supplier reword "Clean" to "No records found" we start certifying stolen
phones.

Related: **never fail over after a definite negative answer.** Fail over on transport failure or an
open circuit only. If provider A says "blacklisted", do not shop for one who says clean.

## Privacy

- **Raw IMEI is never stored, never logged, never in an error message.** Masked (`35•••••••••••78`)
  or hashed only. Enforced by the sentinel test, not by review.
- Two hashes: internal cache/dedupe/abuse key is `HMAC-SHA256(SERVER_PEPPER, digits)`, never
  returned. The `subject.imei_hash` we return is `HMAC-SHA256(tenant_salt, digits)` so a tenant can
  correlate their own records and no one else's.
- `Imei.saltedHash` is a verbatim port of the Kotlin for golden-vector parity. **Compat only** —
  do not use it for server keys.
- The process refuses to boot if `SERVER_PEPPER` is under 32 bytes.

## Money

- Never charge for `unavailable`, nor for `inconclusive(unrecognised_provider_value)` — that one is
  our bug, not their usage.
- Write the `provider_calls` row **before** the HTTP call. A timeout arriving after the provider
  already debited us is the common case.
- `credit_ledger` is the truth; `credit_accounts.balance` is a cache maintained in the same
  transaction and asserted nightly.
- Cached hits cost 20% of list. The global cross-tenant cache is the margin.

## Layout

`packages/contract` (zod → types → OpenAPI, zero deps) ← `packages/identity` (pure, no I/O) ←
`packages/providers` (suppliers, lexicon, router) ← `packages/core` (repositories, cache, charge
matrix, `assemble.ts`) ← `apps/api`, `apps/worker`.

**Nothing depends on `apps/` — including the other app.** Shared domain code goes in
`packages/core`; see ADR-0006. Enforced by dependency-cruiser in CI — the analogue of the app's
`ModuleBoundaryTest`.

`assemble.ts` in `packages/core` is the ONE place a `ProviderOutcome` becomes a `SectionResult`.
It is also the last place caller-facing text is scrubbed of IMEI digits, because an adapter can
construct a `detail` that never passed through the transport's scrubber.

## Commands

`npm test` · `npm run typecheck` · `npm run boundaries` · `/quality` for the full gate · `/leaks`
before any merge that touches logging, persistence or a provider.

The paid routes exist only when `DATABASE_URL` is set. Without it the service runs the free
offline tier — a supported mode, not a degraded one.
