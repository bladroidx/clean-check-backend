# Free `/v1/checks`, paid `/v1/deep_checks`, imei24 as sole supplier

Date: 2026-09-25 · Status: draft, awaiting review

## 1. Intent

- `POST /v1/checks` becomes the **free** check: offline data only (TAC directory → model/brand/specs,
  IMEI validity). It never spends supplier money, by construction.
- `POST /v1/deep_checks` is the **paid** check, answered by pro.imei24.com.
- Every check is stored with the IMEI encrypted (reversible, audited reveal) alongside the
  existing hash — ADR-0007.
- Every route requires the API key (unchanged: single seeded tenant, one caller —
  check-this-phone-backend).
- imei24 is the only upstream. Suppliers `alpha` and `beta` are removed.

### Decisions taken (and rejected alternatives)

| Decision | Chosen | Rejected |
|---|---|---|
| Free data source | Offline TAC only | Scraping imei24.com (ToS: "Payment is required for site usage (bot…)", brittle, no DPA); paying for cheap pro services on the free route (enumeration cost) |
| Deep report contents | Paid sections only; client merges | Superset of free + paid |
| Slow answers | Wait ≤ 10 s, then hand off to polling | Always async; block up to 10 min; 25 s (exceeds caller timeouts) |
| Default deep capabilities | `['blacklist.gsma']` only | Core set; everything incl. MDM |
| Architecture | One orchestrator with `tier: 'free' \| 'deep'` | Two orchestrators; one route with `deep: true` |
| Scope | imei-check only | Coordinated change with check-this-phone-backend |
| Stored IMEI | Encrypted (AES-256-GCM) + hash; reveal via admin-scoped route or CLI, audited (ADR-0007) | Hash only; reveal with the service key; CLI only |
| Spend-cap reason | New arm `spend_cap_reached` | Reusing `provider_not_configured` (false) |

## 2. Routes

| Route | Tier | Answers | Supplier spend |
|---|---|---|---|
| `POST /v1/checks` | free | `identity.model` (TAC) | $0 always |
| `GET /v1/checks/:id` | free | stored free report | $0 |
| `POST /v1/deep_checks` | deep | requested capabilities, default `['blacklist.gsma']` | imei24 |
| `GET /v1/deep_checks/:id` | deep | stored deep report; pending sections update as they resolve | $0 (reads our DB only) |
| `GET /v1/capabilities` | — | capabilities grouped by tier, with imei24 cost | $0 |
| `POST /v1/admin/checks/:id/imei/reveal` | admin | decrypted IMEI of one check (ADR-0007) | $0 |

Unchanged: `/v1/imei/validate`, `/v1/tac/:tac`, `/v1/attributions`, `/healthz`, `/readyz`,
`/metrics`, `/openapi.json`, `/internal/providers/:id/feedback`.

Request bodies for both POST routes keep the current `CheckRequest` shape; `Idempotency-Key` header
as today. Both return `CheckReport` (four-arm envelope, HTTP 200 whenever well-formed and
authorised).

### Boundary rules

- A paid capability requested on `/v1/checks` → that section is
  `unavailable(requires_deep_check)`, not dropped, not an error.
- An offline capability (`identity.model`) requested on `/v1/deep_checks` → **400**
  `capability_not_in_tier`. Deep reports are paid-only; the client merges.
- Idempotency records are scoped per tier; the same key on both routes is not a conflict.
- `checks` rows gain a `tier` column; `GET /v1/checks/:id` only returns `free` rows and
  `GET /v1/deep_checks/:id` only `deep` rows (404 otherwise).

### Contract change: new `Reason` arms `requires_deep_check` and `spend_cap_reached`

Adding an enum arm is a breaking hazard for a shipped Kotlin deserialiser. Before release, confirm
`CleanCheckWire.kt` (check-this-phone) tolerates unknown `Reason` values; if it does not, ship the
app-side tolerance first. Run `/contract` and `/api-versioning`. Reusing
`capability_not_supported_for_device` was rejected: it states something false about the device.

## 3. Orchestrator (`apps/api/src/orchestrator/run-check.ts`)

`runCheck(deps, { ..., tier })`:

- `tier: 'free'` — `deps.router` is **not passed** (type-level: the free call site has no router
  to hand over). Offline capabilities are answered from the TAC directory; any other capability is
  `unavailable(requires_deep_check)`.
- `tier: 'deep'` — only provider capabilities. Cache → dedupe → place → wait window (section 5).

Shared: idempotency, per-tenant concurrency limit, rate limiter, cache, `assemble.ts`, report
persistence.

## 4. imei24 provider

### Transport

imei24 documents DHRU compatibility ("put in your DHRU settings site adres https://pro.imei24.com/,
email adress as username and your API key. Use json format."). Use the existing
`DhruLegacyProvider` (credentials in a POST form body to `/api/index.php`).

- Delete `packages/providers/src/imei24.ts` and its test (the guessed custom-REST adapter).
- Delete `DhruRestProvider`, `alpha.yaml`, `beta.yaml`, their env vars (`ALPHA_*`, `BETA_*`),
  fixtures and tests.
- Config: `IMEI24_USERNAME` (account email), `IMEI24_API_KEY`, `IMEI24_BASE_URL`
  (default `https://pro.imei24.com`; config rejects any non-`https` URL). All-or-nothing; when absent the provider is not built and
  **is listed in `skipped`** (today it is silently omitted when no catalogue exists).
- The key is supplied by the operator via env / secret store. It is never committed, never logged,
  never in Bruno environments.

Fallback, not built now: imei24's own instant API (`apii.php?login=…&apikey=…&action=placeorder`)
returns `RESULTS` as `Label;Value` lines but carries credentials in the query string (leaks into
proxy/access logs). Only considered if recorded fixtures show DHRU does not work for our account.

### Catalogue `packages/providers/catalogue/imei24.yaml`

From the price list dated 2026-09-25 (1 credit = 1 USD):

| service_id | Capabilities | TAC scope | cost_usd | lexicon |
|---|---|---|---|---|
| 486 Global Blacklist checker | `blacklist.gsma` | `*` (fallback) | 0.10 | `imei24-blacklist` |
| 690 Apple warranty / FMI / blacklist / carrier+simlock | `blacklist.gsma`, `lock.activation`, `lock.carrier`, `warranty.status` | Apple | 0.12 | `imei24-apple` |
| 783 Samsung warranty and blacklist | `blacklist.gsma`, `warranty.status` | Samsung | 0.10 | `imei24-samsung` |
| 487 Samsung warranty and carrier v1 | `lock.carrier`, `warranty.status` | Samsung | 0.10 | `imei24-samsung` |
| 678 Apple MDM status | `lock.mdm` | Apple | 1.50 | `imei24-mdm` |
| 428 Motorola, 437 Huawei, 429 LG, 467 Sony, 485 Lenovo, 707 Oppo, 709 Vivo, 488 HTC (warranty) | `warranty.status` | per brand | 0.10 | `imei24-warranty` |

Brand TAC prefix lists come from the TAC directory's brand field, not hand-typed.
`credits` is `0` everywhere (billing removed).

### Service selection

For the requested capability set, choose the fewest services that cover it: brand-specific before
`*`, then cheapest. A service covering several requested capabilities is ordered **once** and its
fields fan out to each section. (Today the router places one order per capability — an iPhone
check would pay #690 four times.)

### Lexicons

- Keyed by `(providerId, lexiconId)`; the adapter's lookup currently ignores provider — fix.
- Ship with **no known-good phrases**. Until scrubbed real fixtures exist, every value is
  `inconclusive(unrecognised_provider_value)` and increments `imei_lexicon_miss_total`. Nothing
  can reach `pass`.
- Known-bad phrases (e.g. `Blacklisted`, `Lost`, `Stolen`, `FMI: ON`) may be added from docs: a false
  `fail` sends the buyer to a remedy; a false `pass` certifies a stolen phone.

### Parsing

- `extractPairs` gains the `;` separator (`Model;Idol3-4.7`, per imei24 docs).
- `Warranty Date;null` and similar literal `null` → absent, never a value.
- Responses echo the IMEI — covered by the transport `scrub`, asserted by the sentinel test.

### `poll()` fix (existing bug)

`DhruLegacyProvider.poll()` interprets every result with `services[0]`. Change the signature to
`poll(orderReference, service, signal)`; the worker and the wait loop pass the service from the
`provider_orders` row (which already stores `service_id`).

## 5. Concurrency, waiting, spend

### One job at a time

imei24: "You can do ONE JOB in time" — a concurrent call returns
`"Your APIKEY is workign in other session"`.

- Every imei24 HTTP call (place, poll, account) runs under `pg_advisory_lock(<hash of 'imei24'>)`,
  held for one HTTP request only. Shared by API and worker processes.
- Lock not acquired within the remaining window → `unavailable(rate_limited_upstream)`; nothing
  placed, no `provider_calls` row.
- The "other session" message is classified as `rate_limited_upstream` (a rejection, never parsed
  for fields).

### Wait window

- `DEEP_CHECK_WAIT_MS` default 10000. **Must stay below every caller's timeout** along the
  chain: Android app read 15 s / call 20 s (`CleanCheckConfig.kt`), check-this-phone-backend →
  imei-check 20 s (`packages/imei-check/src/client.ts`). Config rejects values > 12000. After placing, poll `getimeiorder` (under the lock) until all
  sections resolve or the window ends.
- Unresolved → `inconclusive(awaiting_provider)` with remedy
  "Poll GET /v1/deep_checks/{check_id}".
- `apps/worker` `poll-orders` continues with backoff; after 30 min →
  `unavailable(awaiting_provider_timed_out)`.
- `GET /v1/deep_checks/:id` never calls the supplier.

### Spend protection

1. Field cache first (existing TTLs, ADR-0004); a fresh hit places no order.
2. In-flight dedupe: an open `provider_orders` row for the same (IMEI HMAC, service_id) is attached
   to rather than re-placed. imei24 re-charges every repeat.
3. `provider_calls` row written before the HTTP call (unchanged rule).
4. `IMEI24_DAILY_SPEND_USD` (default 10). When the UTC-day sum of `provider_calls.cost_usd` would
   exceed it, new orders → `unavailable(spend_cap_reached)`, metric
   `imei_provider_spend_cap_reached_total`, alert.
5. Never fail over after a definite negative (router rule retained).

## 6. Data

Migration (dbmate, expand-only):

- `checks.tier text NOT NULL DEFAULT 'deep' CHECK (tier IN ('free','deep'))` — existing rows were
  paid checks, so `deep` is the truthful backfill.
- `idempotency_records`: scope key includes tier.
- `checks.imei_encrypted bytea`, `checks.imei_key_version int` (nullable: pre-existing rows have
  none). Written for **both** tiers.
- `api_keys.scopes` enforced; backfill existing keys to `{checks}`.
- `imei_reveals` append-only audit table (trigger-enforced).
- Index for the dedupe lookup on open `provider_orders (imei_hmac, service_id) WHERE status='pending'`
  (CONCURRENTLY).

## 7. Tests

- Free route: never constructs/calls a provider (spy); paid capability → `requires_deep_check`.
- Deep route: `identity.model` → 400; default capability set = blacklist only.
- Service selection: iPhone with 4 capabilities → exactly one #690 order.
- Lock contention: two parallel deep checks serialise; timeout → `rate_limited_upstream`.
- "Other session" body → `rate_limited_upstream`, never `pass`.
- Window expiry → `awaiting_provider`; worker later resolves; `GET /v1/deep_checks/:id` reflects it.
- `poll()` uses the order's service lexicon, not `services[0]`.
- Cache hit and in-flight dedupe place no order; spend cap blocks new orders.
- Empty lexicon: realistic "Clean" fixture → `inconclusive(unrecognised_provider_value)`.
- `;`-separated blob parsing; literal `null` is absent.
- Sentinel IMEI leak test over imei24 fixtures (IMEI echoed in body).
- Encryption: round-trip; tampered ciphertext / wrong `check_id` AAD fails; short key refuses
  boot; key rotation reads old version.
- Reveal: `checks`-scoped key → 403; admin key → 200 + audit row; audit write failure → no
  decrypt; admin key on `/v1/checks` → 403; response `no-store` and absent from logs.
- Sentinel: no plaintext sentinel digits in DB/logs/responses except the reveal response.
- Contract: OpenAPI diff reviewed; `requires_deep_check` compatibility checked.

Gates: `npm test`, `npm run typecheck`, `npm run boundaries`, `/quality`, `/leaks`, `/contract`.

## 8. Release blockers (outside the code)

1. imei24 account has 0 credits; no real call has been made.
2. No recorded fixtures → no known-good phrases → every answer inconclusive. Operator records with
   the key in a local `.env`; the script scrubs IMEI and credentials before writing.
3. DHRU compatibility of imei24 unverified.
4. **Deploy order:** check-this-phone-backend's paid `POST /checks` forwards to `/v1/checks` and
   charges the user 1 credit. Once this ships, that would charge for the free offline answer. That
   backend must repoint to `/v1/deep_checks` (and add a free proxy for `/v1/checks`) before or with
   this deploy. Out of scope here by decision.
5. `requires_deep_check` / `spend_cap_reached` tolerated by the Android deserialiser.
6. imei24 is a **data processor** receiving raw IMEIs: no DPA; jurisdiction unknown (third-country
   transfer question). `docs/privacy.md` must name it, and state that IMEIs are stored encrypted
   (ADR-0007). Only the IMEI and service ID are ever sent — no user or tenant identifier.
7. `IMEI_ENCRYPTION_KEY(S)` provisioned in the secret store, separate from DB backups.
8. Known gaps in check-this-phone-backend (out of scope): no IMEI log guard / redaction; its
   `IMEI_CHECK_BASE_URL` is not forced to `https`.

## 9. Out of scope

- check-this-phone-backend changes.
- imei24 instant (`apii.php`) transport.
- Paying for cheap services on the free route (possible later as a catalogue `tier` flag).
- Unlocking / iCloud-removal services.
