---
name: provider-adapter-authoring
description: Add a provider integration to imei-check end to end — catalogue YAML, DHRU legacy and REST transports, the async order lifecycle and feedback webhook, normalisation, the 15-case fixture matrix, circuit breaker, router registration and cost accounting. Use when adding a supplier, adding a service to an existing supplier, or repairing an adapter after a format change.
---

<role>
This skill is the procedure for integrating a supplier correctly the first time. An adapter is not
done when it returns data — it is done when every way the supplier can fail produces the right arm,
and none of them produces a `pass`.
</role>

<context>
```ts
interface Provider {
  readonly id: ProviderId;
  catalogue(): ServiceEntry[];
  supports(cap: Capability, subject: Subject): Support;
  execute(req: ProviderRequest, ctx: ProviderContext): Promise<ProviderOutcome>;
  poll?(handle: OrderHandle, ctx: ProviderContext): Promise<ProviderOutcome>;
  parseWebhook?(raw: RawWebhook): WebhookEvent;
  health(): HealthSnapshot;
}

type ProviderOutcome =
  | { kind: 'answered'; fields: NormalisedFields; raw: RawCapture; costUsd: number; latencyMs: number }
  | { kind: 'pending';  handle: OrderHandle; etaSeconds?: number; costUsd: number }
  | { kind: 'rejected'; reason: RejectionReason; retryable: boolean; costUsd: 0 }
  | { kind: 'failed';   reason: FailureReason;   retryable: boolean; costUsd: number };
```

**Adapters never construct a `SectionResult`.** The conversion is in one file,
`apps/api/src/report/assemble.ts`, so no adapter can invent a fifth arm or emit a `pass`.

Two dialects: legacy DHRU Fusion (`POST /api/index.php`, form-encoded, `parameters` as base64 JSON,
`{SUCCESS, ERROR, apiversion}` envelope) and modern REST (Bearer, `/account` `/products` `/order`,
`feedback_url` webhook with base64 `replay`). Order `STATUS` codes vary per installation.
</context>

<rules>
1. **Catalogue before code.** Capabilities come from a checked-in YAML, never from parsing a
   seller-authored `SERVICENAME` like `"🔥 iPhone GSX Full Info (FAST) 🔥"`.
2. **Fixtures before parser.** You cannot normalise output you have not seen.
3. **`supports()` filters before spending** — an Apple-only service on an Android TAC makes no call.
4. **Write the `provider_calls` row before the HTTP call**, status `in_flight`.
5. **Failover on transport failure or open circuit only** — never after a definite negative answer.
6. **A repriced service is auto-disabled**, not absorbed.
7. **Never log or persist a raw supplier body** outside `provider_call_bodies` (7 d, sanitised).
8. **Per-attempt timeout = `sla.p95_ms × 1.5`**, ceiling 30 s sync.
9. **The webhook is never the only completion path.** The poller is the safety net.
</rules>

<workflow>
1. **Catalogue.** Call `imeiservicelist` / `GET /products`. Write `src/catalogue/<provider>.yaml`.
2. **Record fixtures** for the 15-case matrix (see below).
3. **Transport.** Reuse `dhru/legacy.ts` or `dhru/rest.ts`; add only what is genuinely different.
4. **Normalise.** Follow `normalisation-lexicon`. Extract → alias → lexicon.
5. **Order lifecycle** if the service is async: `pending` → `provider_orders` row → webhook route +
   poller with 15 s → 5 min backoff → hard 24 h expiry releasing the reservation.
6. **Breaker**: 50% failure over 20 calls in 60 s, half-open probe at 30 s.
7. **Register** in `registry.ts` with cost and priority.
8. **Wire the drift job** entry so a rename or reprice is caught nightly.
9. `npm test -- providers` and paste the real output.
</workflow>

<examples>
<example name="catalogue-entry">
```yaml
provider: sickw
services:
  - service_id: "30"
    name_snapshot: "GSX Full Info"
    capabilities: [identity.model, lock.activation, lock.mdm,
                   warranty.status, warranty.purchase_date, network.sold_by]
    subject: apple_only            # supports() rejects non-Apple TACs with no HTTP call
    registries: [apple_gsx]
    regions: ["*"]
    sla: { p50_ms: 4000, p95_ms: 20000, mode: sync }
    cost: { credits: 4, provider_cost_usd: 0.35 }
    enabled: true
```
`name_snapshot` exists only so the nightly drift job can tell you the seller renamed or repriced it.
</example>

<example name="the-15-case-fixture-matrix">
```
clean · blacklisted · icloud-on · icloud-off · carrier-locked · carrier-unlocked
unknown-imei · malformed-html · waf-html-200 · xml-when-json-requested
success-wrapping-error · credit-exhausted · upstream-rate-limited · timeout
unrecognised-status          ← the one the product rests on
```
`waf-html-200` — a `200 OK` carrying a Cloudflare challenge — is the single most common failure in
this ecosystem. It is `failed(retryable: true)`, never `answered` with empty fields.
</example>

<example name="transport-hazards-each-needing-a-fixture">
- `200 OK` with an HTML error or parked-domain page
- `SUCCESS` present *and* containing an error message in `MESSAGE`
- `ERROR` and `SUCCESS` both present
- XML although `requestformat` said JSON
- gzip claimed but not applied; a BOM; Windows-1252 bytes labelled UTF-8
- an order `STATUS` integer this seller uses differently from the last one
</example>
</examples>

<format_constraints>
```
PROVIDER — <provider>/<service_id>
 CATALOGUE  <capabilities> · subject <x> · cost <n>cr / $<n> · p95 <ms>
 FIXTURES   <n>/15 — MISSING <cases>
 LEXICON    <field>: <n> values · miss → inconclusive [VERIFIED <test:line>]
 ASYNC      webhook <path> · poller <backoff> · expiry <24h> · reservation release [VERIFIED]
 BREAKER    <threshold> · timeout <ms>
 COST       pre-call row [VERIFIED <test:line>]
 DRIFT      registered <y/n>
```
Never report done with an incomplete matrix.
</format_constraints>
