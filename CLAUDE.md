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

- **Raw IMEI is never stored in plaintext, never logged, never in an error message.** Masked
  (`35•••••••••••78`) or hashed in every column and every response. Enforced by the sentinel test,
  not by review.
- **Every check stores its IMEI AES-256-GCM encrypted (ADR-0007)** — `checks.imei_encrypted` /
  `imei_key_version`, on top of the hash, not instead of it. Only an `imei:reveal`-scoped key on
  `POST /v1/admin/checks/:id/imei/reveal`, or `npm run imei:reveal` on a trusted host, can decrypt
  it — one shared code path (`packages/core/src/crypto/reveal.ts`) that writes an append-only audit
  row (`imei_reveals`, reason scrubbed of IMEI-shaped digits) **before** it ever decrypts. A key
  holding both `imei:reveal` and `checks:write` is refused outright: the service key can never
  reach the reveal route. See `docs/privacy.md`.
- Two hashes: internal cache/dedupe/abuse key is `HMAC-SHA256(SERVER_PEPPER, digits)`, never
  returned. The `subject.imei_hash` we return is `HMAC-SHA256(tenant_salt, digits)` so a tenant can
  correlate their own records and no one else's. (The parsing rule above is unchanged by any of
  this — encryption is a storage decision, not a normalisation one.)
- `Imei.saltedHash` is a verbatim port of the Kotlin for golden-vector parity. **Compat only** —
  do not use it for server keys.
- The process refuses to boot if `SERVER_PEPPER` is under 32 bytes, or if `IMEI_ENCRYPTION_KEYS` is
  missing or malformed once `DATABASE_URL` is set.

## Money

**Billing was removed.** This service runs single-consumer — one seeded tenant/API key
(`npm run seed:service-tenant`) for a single trusted caller (check-this-phone's backend), not a
multi-tenant self-serve product. There is no `credit_ledger`, no `credit_accounts`, no charge
matrix, no `/v1/balance`: nothing is ever charged, and `CheckReport.billing.credits_charged` is
always `0` on the wire. `tenants`/`api_keys` still exist for auth (single seeded row); everything
that only ever served billing, the abuse ladder or outbound completion webhooks does not.

What still matters even with no billing:

- Write the `provider_calls` row **before** the HTTP call. A timeout arriving after the provider
  already responded is the common case, and this is our own spend visibility — not a customer's
  bill, but still real money leaving the business.
- The global cross-tenant field cache (`packages/core/src/cache/store.ts`) is untouched and still
  the thing that keeps supplier spend down; it just no longer has a customer-facing price.
- imei24 (the one supplier wired up) has its own real-money guard independent of billing:
  `IMEI24_DAILY_SPEND_USD` (default `10`) caps daily spend; past it a section is
  `unavailable(spend_cap_reached)`, never a silent overspend.

## Routes

Free, offline: `POST /v1/checks` + `GET /v1/checks/:id` — IMEI validation and TAC identity only;
anything else comes back `unavailable(requires_deep_check)`. Deep, supplier-backed:
`POST /v1/deep_checks` + `GET /v1/deep_checks/:id` — defaults to `['blacklist.gsma']`;
`identity.model` here is `400 capability_not_in_tier`. `POST /v1/deep_checks` is bounded by one
total time budget from request start (`DEEP_CHECK_WAIT_MS`, default 10 s, max 12 s); past it a
pending section is `inconclusive(awaiting_provider)` with the poll route as its remedy.

## Layout

`packages/contract` (zod → types → OpenAPI, zero deps) ← `packages/identity` (pure, no I/O) ←
`packages/providers` (suppliers, lexicon, router) ← `packages/core` (repositories, cache,
`assemble.ts`) ← `apps/api`, `apps/worker`.

**Nothing depends on `apps/` — including the other app.** Shared domain code goes in
`packages/core`; see ADR-0006. Enforced by dependency-cruiser in CI — the analogue of the app's
`ModuleBoundaryTest`.

`assemble.ts` in `packages/core` is the ONE place a `ProviderOutcome` becomes a `SectionResult`.
It is also the last place caller-facing text is scrubbed of IMEI digits, because an adapter can
construct a `detail` that never passed through the transport's scrubber.

## Commands

`npm test` · `npm run typecheck` · `npm run boundaries` · `/quality` for the full gate · `/leaks`
before any merge that touches logging, persistence or a provider. `npm run seed:admin-key` mints
the `imei:reveal`-only key; `npm run imei:reveal -- <check_id> --reason "..."` reveals from a
trusted host (same 10–500 char reason bound as the HTTP route). imei24's brand-specific services
key off `applies_to_manufacturers`, matched against the TAC directory at runtime — there is no
generated prefix list or script for it (see ADR-0002 / catalogue YAML comments).

Every check route (the free `POST /v1/checks` and `/v1/capabilities` included, not just the deep
ones) exists only when `DATABASE_URL` is set. Without it the service runs only the offline
validator and TAC lookup — a supported mode, not a degraded one. Once `DATABASE_URL` is set, every
route, including the free ones, requires the single seeded API key: there is exactly one caller.

## Before deploying this branch

Two changes live outside this repo and must land before or with this deploy, or the two services
disagree about what "clean" means:

- **check-this-phone-backend** must repoint its paid `/checks` call to `POST /v1/deep_checks` (plus
  the `GET` poll route), and proxy `/v1/checks` as the free tier — spec §8.4.
- **check-this-phone** (the Android app) must tolerate the new `Reason` arms `requires_deep_check`
  and `spend_cap_reached` in its `ProbeResult` deserialiser, or an unrecognised arm breaks instead
  of degrading — spec §8.5.
