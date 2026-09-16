# Architecture — a guide for new developers

This document is the map. It explains what the service does, how the code is organised, the
language/runtime choices, and the load-bearing decisions you need to know before you touch
anything. It does not repeat what the ADRs already say well — it points to them at the right
moment instead.

Read in this order if you're new: this file → [`CLAUDE.md`](../CLAUDE.md) (the short version of the
rules) → the ADR you're about to violate, before you violate it.

---

## 1. What this service is, in one paragraph

`imei-check` answers *"is this phone clean?"* from an IMEI. It does not have its own access to the
GSMA lost/stolen registry — nobody outside an operator, manufacturer or insurer does. It buys
answers from grey-market resellers, and its entire value proposition is **honesty about that fact**:
a stable schema, metadata that says exactly what an answer covers and doesn't, and a hard rule that
"we don't know" is never quietly rendered as "it's fine". Read
[`CLAUDE.md`](../CLAUDE.md) for the one-paragraph version of why this matters; it is the thesis the
whole codebase is built to defend.

Two tiers:

- **Free, offline.** IMEI validation (Luhn check), device identity from a bundled Type Allocation
  Code (TAC) directory. No network call, no database required.
- **Paid.** Blacklist status, carrier/activation/MDM lock, warranty. Requires an API key and calls
  out to supplier APIs — "paid" names the capability tier, not a bill: billing was removed, see §7.

---

## 2. Language, runtime, and why

| Choice | What | Why |
|---|---|---|
| Language | TypeScript, strict mode + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` | The four-arm contract and the charge matrix are the kind of logic where "it compiled" should mean something. See §5. |
| Runtime | Node.js (≥20 dev, Node 22 in Docker) | Node 22 has native fetch/AbortSignal.timeout/`Response`, all used directly in the provider transport — no HTTP client dependency needed. |
| HTTP framework | [Fastify 5](https://fastify.dev) | Schema-first routing via [`fastify-type-provider-zod`](https://github.com/turkerdev/fastify-type-provider-zod) — one zod schema drives validation, TypeScript types, *and* the generated OpenAPI document. No hand-maintained duplicate of the wire shape. |
| Schema/validation | [zod](https://zod.dev) | Runtime validation with inferred static types from one source. Used for the entire wire contract in `packages/contract`. |
| Database | PostgreSQL 17, plain SQL migrations via [dbmate](https://github.com/amacneil/dbmate) | No ORM. The money and idempotency logic (`FOR UPDATE`, `ON CONFLICT`, `SKIP LOCKED`) is exactly the kind of thing an ORM abstracts badly. See `packages/core/src/db/pg.ts`. |
| Logging | [pino](https://getpino.io) | Fast, structured JSON logs — wrapped in a custom write-boundary guard (§8) that makes an IMEI leak a thrown exception in dev/test. |
| Metrics | [prom-client](https://github.com/siimon/prom-client) | Standard Prometheus exposition at `GET /metrics`. |
| Testing | [Vitest](https://vitest.dev) | Fast, native ESM, built-in coverage via v8. |
| Package management | npm workspaces (no Lerna/Turborepo/Nx) | The dependency graph is small and linear enough that workspaces alone are sufficient; see §3. |
| Provider HTTP mocking | [undici](https://undici.nodejs.org)'s `MockAgent` | Tests the real HTTP transport code (headers, status codes, timeouts) against a mocked network layer, not a hand-rolled fetch stub. |

**Nothing here is exotic.** If you know Node + TypeScript + Postgres, you can read this codebase.
The complexity is in the *rules*, not the tools.

---

## 3. The module graph

```
packages/contract   (zod schemas → types → OpenAPI. Zero deps but zod.)
        ↑
packages/identity    (IMEI parsing/Luhn/masking/hashing, TAC directory. Pure — no I/O, no clock, no env.)
        ↑
packages/providers   (Provider interface, DHRU adapters, the normalisation lexicon, the router)
        ↑
packages/core        (repositories, field cache, charge matrix, metrics, assemble.ts)
        ↑
   apps/api  apps/worker      (composition only: HTTP routing, auth, the two process entrypoints)
```

This is enforced mechanically, not just by convention — `.dependency-cruiser.cjs` runs in CI and
fails the build on a violation. The rule that matters most: **nothing depends on `apps/`,
including the other app.** `apps/worker` does not import `apps/api`; anything both processes need
lives in `packages/core`. See [ADR-0006](adr/0006-domain-lives-in-packages-core.md) for why this
wasn't the original plan and what broke to make it necessary.

### What lives where

| Package | Responsibility | Depends on |
|---|---|---|
| `packages/contract` | The wire format. zod schemas for every request/response shape, the closed enums (`Outcome`, `Capability`, `Reason`, `Remedy`...), and the seven cross-field invariants that a zod object schema can't express on its own. | zod only |
| `packages/identity` | `Imei` (parse, Luhn-validate, mask, hash) and `TacDirectory`. Ported from the sibling Android app's Kotlin so both sides agree on golden test vectors. | contract's *types* only, no runtime dep |
| `packages/providers` | Talks to suppliers. The `Provider` interface, DHRU legacy (HTML-in-JSON) and REST (bearer + webhook) transports, the extract→alias→lexicon normalisation pipeline, the circuit breaker, and the `Router` that decides which supplier to try and whether to fail over. | contract, identity |
| `packages/core` | The domain. Repository interfaces + two implementations (Postgres, in-memory), the field cache with its TTL table, Prometheus metrics, and `assemble.ts` — the single function that turns a supplier's answer into a public `SectionResult`. | contract, identity, providers |
| `apps/api` | Fastify server. Routes, auth, rate limiting, and `run-check.ts` (the orchestrator that ties cache → router → assemble together for one HTTP request). | everything above |
| `apps/worker` | A separate long-running process: polls async supplier orders, ingests TAC data. | everything above, **not** `apps/api` |

---

## 4. Request lifecycle — the paid path, end to end

This is the path worth understanding first, because it's where every subsystem meets.

```
POST /v1/checks
  │
  ▼
apps/api/src/auth/plugin.ts         Bearer key → SHA-256 lookup → tenant. Same 401 body whatever
  │                                  went wrong (unknown/revoked/expired key look identical). One
  │                                  seeded tenant in single-consumer mode — see §7.
  ▼
apps/api/src/routes/checks.ts       Luhn-validate the IMEI FIRST (free). Claim the
  │                                  Idempotency-Key: if seen before, replay the stored response
  │                                  verbatim and stop here.
  ▼
apps/api/src/orchestrator/
  run-check.ts                      For each requested capability, in order:
  │
  │   1. identity.model?        → answer from the in-memory TacDirectory. Free.
  │   2. Otherwise → check packages/core/src/cache/store.ts first (keyed on the field, not the
  │      whole response — see ADR-0004).
  │   3. Cache miss → packages/providers' Router picks the cheapest provider that covers this
  │      TAC for this capability, executes it (or fails over — but ONLY on transport failure,
  │      never after a definite answer; see §6). No affordability gating: billing is off, so
  │      every requested capability simply runs.
  │   4. packages/core/src/report/assemble.ts turns the ProviderOutcome into a SectionResult:
  │      the one place in the whole codebase that decides pass/fail/inconclusive/unavailable.
  ▼
Response: a CheckReport. Always HTTP 200 if the request was well-formed and authorised — even if
every single section came back `unavailable`. `billing.credits_charged` is always `0`. See ADR-0001.
```

If a capability triggers a **standard** (non-express) supplier order, `run-check.ts` writes a
`provider_orders` row and returns the check as `status: "partial"`. `apps/worker`'s
`poll-orders.ts` job picks it up later, or the supplier's webhook arrives at
`POST /internal/providers/:id/feedback` (`apps/api/src/routes/provider-feedback.ts`) and settles it
immediately. Either way, the *same* `assemble.ts` logic runs — which is exactly why that logic had
to live in `packages/core` and not in `apps/api`.

---

## 5. The four-arm contract — the central abstraction

Read [ADR-0001](adr/0001-four-arm-wire-contract.md) for the full reasoning. The short version:

Every section of every response is **exactly one** of:

```
pass          — we checked, and it's fine. Always carries evidence.
fail          — we checked, and it's not fine. Always carries a Finding.
inconclusive  — we asked and got a non-answer. Always carries a reason + a remedy.
unavailable   — we never got an answer at all. Never an error, never silently a pass.
```

There is deliberately **no top-level boolean**. `{"clean": true}` either helps sell a stolen phone
(false positive) or defames an honest seller (false negative), and a three-valued outcome forces
every caller to handle "we don't know" as its own case instead of defaulting it to something.

This isn't just documented convention — it's enforced in code, at two layers:

1. **Type-level, in `packages/contract/src/section.ts`.** The constructor functions `pass()`,
   `fail()`, `inconclusive()`, `unavailable()` are the *only* way to build a `SectionResult`. You
   cannot type an `inconclusive` without a `remedy` — it's a compile error, not a runtime check.
2. **Runtime, in `packages/contract/src/invariants.ts`.** Seven cross-field invariants that zod's
   object schema can't express (e.g. "a `pass` must carry evidence", "`unavailable`'s `coverage`
   describes what a *good* answer would have covered"). `assertSectionInvariants()` runs on every
   section `assemble.ts` builds, in every environment — not just in tests.

**If you're adding a new capability or provider**, read
[`.claude/skills/four-arm-contract/SKILL.md`](../.claude/skills/four-arm-contract/SKILL.md) before
you write the code that decides an outcome. Getting the `inconclusive`/`unavailable` boundary wrong
is the single most consequential bug this codebase can have — it's the difference between an honest
amber answer and a stolen phone being certified clean.

---

## 6. The parsing rule and provider abstraction

**Absence of the word "blacklisted" is not proof of clean.** A section is only ever `pass` on a
*positive* match against a known-good phrase. See
[ADR-0002](adr/0002-provider-abstraction.md) for the full design, and
[`packages/providers/src/normalise/lexicon.ts`](../packages/providers/src/normalise/lexicon.ts) for
the implementation.

The pipeline, concretely:

```
supplier's raw text/JSON blob
   │
   ▼  extract.ts    — turn "Label: Value<br>" HTML soup (or nested JSON) into {label, value} pairs
   │
   ▼  lexicon.ts    — alias the label onto a canonical field, then match the value against a
   │                  per-field, per-value table. THREE outcomes here, not two:
   │                    - a KNOWN placeholder ("N/A", "None") on a text field → silently absent
   │                    - an unmatched value on an ENUM field (the deciding field) → LOUD miss,
   │                      increments imei_lexicon_miss_total, never charged
   │                    - a positive match → a value
   │
   ▼  assemble.ts   — the deciding field's value picks the arm. No `else { return pass }`
                       branch exists anywhere in this file.
```

Why the "known absence vs. unrecognised" split matters: "Blacklist Records: None" on an
otherwise-clean device is the supplier working correctly, not drift. If that raised a miss, the
drift alarm would fire on every clean handset and get muted within a week — which is precisely the
failure mode a drift alarm exists to prevent. See the comment block at the top of `lexicon.ts` for
the full "polarity trap" explanation (the same word "clean" means opposite facts on
`blacklist.status` vs. `lock.activation.status`).

**Never fail over after a definite negative answer.** If supplier A says "blacklisted", the
`Router` (`packages/providers/src/router.ts`) does not ask supplier B hoping for a nicer answer —
that would make this service a laundering tool for a reseller with two API keys. Failover happens
*only* on `ProviderOutcome.kind === 'failed'` (transport error, timeout, open circuit). This is the
single most load-bearing `if` statement in the router; see `router.test.ts` for the fraud-vector
test that pins it.

---

## 7. Money: removed

This service used to run a full multi-tenant charge matrix and append-only credit ledger
(`credit_accounts`/`credit_ledger`, `packages/core/src/billing/pricing.ts`). That subsystem was
removed: the service now runs **single-consumer** — one seeded tenant/API key
(`npm run seed:service-tenant`) for a single trusted caller, not a self-serve product with
customers to bill. Nothing is ever charged; `CheckReport.billing.credits_charged` is always `0`.
The abuse/enumeration ladder and outbound completion webhooks (`tenant_restrictions`,
`enumeration_buckets`, `webhook_endpoints`, `webhook_deliveries`) were removed in the same pass,
for the same reason — they only ever existed to manage multiple tenants' accounts.

What's still true and still worth knowing:

- `provider_calls` rows are still written **before** the supplier is called (in `services.ts`'s
  router hooks) — a timeout arriving after a supplier already responded is the common case, and
  this is our own spend visibility, not a customer's bill.
- The global cross-tenant field cache (`packages/core/src/cache/store.ts`, section 9 below) is
  untouched — it's what keeps supplier spend down, it just has no customer-facing price anymore.
- `tenants`/`api_keys` still exist and are unrelated to this removal — see
  `apps/api/src/auth/plugin.ts` for the Bearer-key check every route now goes through once
  `DATABASE_URL` is set.

---

## 8. Privacy: the sentinel test and the log tripwire

[ADR-0003](adr/0003-no-raw-imei-at-rest.md) is the design; here's how it's actually enforced, which
is unusual enough to be worth explaining to a newcomer.

**The log tripwire** (`apps/api/src/lib/log.ts`): every string written to the log sink is scanned
for a 14+ digit run that isn't a decimal fraction. Outside production, a match **throws** — an
uncaught exception, deliberately, so the bug surfaces in dev/test rather than being silently
redacted and forgotten. In production it redacts instead (a logging call must never crash a live
request). Read the docstring at the top of that file — it explains a real incident where the
original, looser regex matched Fastify's `responseTime` float and crashed the server on literally
every request.

**Two separate hashes**, never confused:

| | Construction | Purpose |
|---|---|---|
| Internal | `HMAC-SHA256(SERVER_PEPPER, digits)` | Cache key, dedupe, abuse bucket. **Never returned to any caller.** |
| Returned | `HMAC-SHA256(tenant_salt, digits)` | `subject.imei_hash` in the API response — lets one tenant correlate their own records, and *only* their own, since the salt is per-tenant. |

Both refuse a key/salt under 32 bytes — checked at the *earliest* point possible (tenant creation
for the salt, process boot for the pepper), not at first use. A 15-digit space is enumerable in
seconds, so a short key doesn't pseudonymise anything; it's the number with extra steps.

**The sentinel test** (`apps/api/test/sentinel.test.ts`) is the test that actually catches leaks in
practice: it runs a fixed, fake-but-Luhn-valid IMEI through every code path — free tier, paid tier,
every outcome arm, the cache — then greps everything the process produced (responses, logs, stored
rows) for the raw digits. It found two real leaks during
development (a supplier error message reaching `detail`, and the IMEI landing in a query string on
`GET /v1/capabilities`) — see the commit history for exactly what broke and how it was fixed. If
you add a new code path that touches an IMEI, extend this test; don't just trust review.

---

## 9. Caching: fields, not responses

[ADR-0004](adr/0004-cache-at-the-field-level.md). One supplier call can return four facts with wildly
different volatility — a purchase date never changes, an activation-lock state can flip in the
time it takes a seller to sign out of iCloud. Caching the whole response forces one TTL across all
of them, which is wrong for most of them.

So `packages/core/src/cache/store.ts` caches per **canonical field**
(`packages/providers/src/fields.ts` defines the vocabulary — `blacklist.status`,
`lock.activation.status`, etc.), and `packages/core/src/cache/ttl.ts` is one file with every TTL
and the argument for it written next to the value. The asymmetry that matters most:
`blacklist.status = clean` expires in **60 minutes**; `blacklist.status = blocked` lasts **24
hours** — because a stale "blocked" costs a seller a sale and is recoverable, while a stale "clean"
can help sell a stolen phone and isn't.

`max_age_seconds: 0` in a request bypasses the cache entirely — without that escape hatch, the
`freshness.age_seconds` promise in every response would be unfalsifiable.

---

## 10. Where to look for a given question

| I want to... | Start here |
|---|---|
| Understand the wire format | `packages/contract/src/envelope.ts` (shapes) + `enums.ts` (closed vocabularies) |
| Add a new provider/supplier | `.claude/skills/provider-adapter-authoring/SKILL.md`, then `packages/providers/src/dhru/` for a worked example |
| Change what counts as pass/fail for a capability | `packages/core/src/report/assemble.ts` — and read the invariants file first |
| Understand cache TTLs | `packages/core/src/cache/ttl.ts` |
| Add a database column/table | `db/migrations/` — plain SQL, dbmate, `-- migrate:up` / `-- migrate:down` markers |
| Understand auth | `apps/api/src/auth/plugin.ts` + `keys.ts` — one seeded tenant/API key, single-consumer mode |
| Run everything locally | root `README.md` "Quick start" |
| Understand *why* a decision was made | `docs/adr/000N-*.md` — check here before assuming something is arbitrary |

---

## 11. Non-obvious things that will trip you up

- **The paid routes don't exist unless `DATABASE_URL` is set.** `apps/api/src/app.ts` only
  registers `checkRoutes`/`providerFeedbackRoutes`/`/metrics` when a `services` object is passed
  in. Running without a database is a *supported* mode (the free tier), not a broken one — but the
  failure mode is a plain 404 on every paid route, which reads exactly like a routing bug until you
  remember this. `npm run dev` and `npm run start` load `.env` from the repo root automatically
  (`node --env-file-if-exists=.env`, wired into `apps/api/package.json` and
  `apps/worker/package.json`) — copy `.env.example` once and this stops being something you have to
  remember per shell session. **This does not run in Docker**: the image's `CMD` invokes
  `node apps/api/dist/server.js` directly, bypassing `npm run start` and its flag entirely, so
  compose's `environment:` block is still how the container gets its config.
- **With `DATABASE_URL` set, EVERY route requires the API key, including the free ones.**
  `/v1/imei/validate` and `/v1/tac/:tac` are gated behind `requireTenant` in that mode too (see
  `app.ts`) — this service has exactly one caller and nothing on it is public once a database is
  configured. Without a database, those same routes stay open (no key store to check against).
- **`GET /metrics` needs no API key** even when `DATABASE_URL` is set, but it still only exists in
  that mode (registered directly in `app.ts`, not behind `requireTenant`) — a Prometheus scraper
  monitoring process health in free-tier mode gets a 404.
- **`apps/worker` refuses to start without `DATABASE_URL`** — there's nothing for it to do in the
  free tier, so it exits rather than idling.
- **A provider with no credentials configured is simply not built** — not built-and-failing. See
  `apps/api/src/providers/build.ts`. This means `blacklist.gsma` can legitimately come back
  `unavailable(provider_not_configured)` in a dev environment with no supplier keys, and that's the
  *correct*, tested behaviour — not a bug to chase.
- **`Imei.saltedHash()` is compat-only.** It's a verbatim port of the Android app's Kotlin
  (`sha256("salt:digits")`) kept only so both sides can be checked against the same golden test
  vectors. Never use it for a server-side key — use `Imei.hmac()`, which refuses a key under 32
  bytes.
- **The module boundary is enforced by `npm run boundaries` (dependency-cruiser), not just by
  convention.** If your PR makes `apps/worker` import from `apps/api`, or makes `packages/core`
  reach back into `apps/`, the build fails. This is deliberate friction.
- **A `SectionResult` is never constructed by hand outside `assemble.ts`.** Even inside
  `apps/worker`'s order-polling job, settling an order calls the *same* `assembleSection()` from
  `packages/core` — there is exactly one place in the codebase that decides an outcome arm.

---

## 12. Testing philosophy, briefly

- Unit tests run with **no external services** — Postgres is swapped for
  `packages/core/src/db/memory.ts`, an in-memory implementation of the exact same repository
  interfaces the Postgres implementation satisfies. This is why idempotent-retry logic can be
  tested exhaustively and fast.
- Provider HTTP behaviour is tested against `undici`'s `MockAgent`
  (`packages/providers/test/transport.test.ts`) — real fetch calls, mocked network, so headers,
  status-code handling and timeouts are actually exercised.
- Coverage thresholds are tiered by how much a bug there costs (see `vitest.config.ts`):
  `packages/identity` (95%) > `packages/contract` (90%) > `packages/providers`/`packages/core`
  (75-80%) > `apps/api` (60%) — the packages closest to "a bug here is a lie to a buyer" have the
  highest floor.
- `npm run test:sentinel` runs just the IMEI-leak sweep on its own — run it after any change that
  touches logging, persistence, or a provider adapter, even if the full suite is green.

For the full quality gate (lint, types, boundaries, tests, coverage, leak sweep, schema diff), see
`/quality` or [`.claude/skills/backend-quality-gate/SKILL.md`](../.claude/skills/backend-quality-gate/SKILL.md).
