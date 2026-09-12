# 0003 — No raw IMEI at rest, in a log, or in telemetry

**Status:** Accepted · 2026-09-12
**Applies to:** every package, every table, every log line, `docs/privacy.md`

## Context

An IMEI is personal data under GDPR Art. 4(1). The space is ~10^14 and enumerable in seconds, so an
unsalted digest of one is not anonymous — it is as identifying as the number.

This is a trust product. A quiet leak here is not a privacy incident; it is a contradiction of the
thing being sold.

The realistic leak is not our own format strings. It is a supplier's free-text error body, echoed
straight into a logger, containing the IMEI we just sent them.

## Decision

**Raw IMEI never persists.** Not in a column, not in a `jsonb` evidence blob, not in a metric label,
not in a span attribute, not in an outbound webhook, not in an OpenAPI example. Responses carry
`imei_masked` (`35•••••••••••76`).

**Two hashes, different constructions, different purposes:**

| | Construction | Purpose | Returned? |
|---|---|---|---|
| Internal | `HMAC-SHA256(SERVER_PEPPER, digits)` | cache, dedupe, abuse accounting | never |
| Per-tenant | `HMAC-SHA256(tenant_salt, digits)` | lets a tenant correlate their own records | yes, as `subject.imei_hash` |
| Compat | `SHA-256("salt:digits")` | byte-parity with the Android app's local record | never used server-side |

**The process refuses to boot** if `SERVER_PEPPER` is under 32 bytes, with a message saying why.

**The guard sits at the log write boundary**, not in a pino hook and not in a `redact` path list.

## Alternatives rejected

**`redact: { paths: [...] }` alone.** Rejected: the risk is an IMEI inside a field we cannot name in
advance. A path list can only censor fields somebody predicted.

**A pino `hooks.logMethod` guard.** Tried, rejected during implementation: hooks run *before*
serializers, so they inspect the raw Fastify request rather than the line that would be written —
missing what a serializer adds and tripping on what it strips.

**Reusing the Kotlin `sha256("salt:digits")` for server keys.** Rejected: HMAC is the construction
designed for keyed hashing, and the server is where the whole keyspace is worth attacking. The
Kotlin form is kept, marked compat-only, purely so both sides agree on the golden vectors.

**Claiming the data is anonymous.** Rejected as false. We hold a keyed hash *and* a lookup log and
can answer "what do you hold on IMEI X" by recomputing. That is pseudonymised personal data, in
scope.

## Consequences

- Support cannot look a customer up by IMEI directly; they use an endpoint that hashes the input.
- Rotating `SERVER_PEPPER` invalidates the cache (acceptable) and makes historical `checks` rows
  correlate with nothing (acceptable — they are write-only audit).
- Outside production the logger **throws** on IMEI-shaped digits. A logging bug fails a test rather
  than shipping. In production it redacts, because a log call must not take down a request.
- Fastify's default `req` serializer had to be replaced with an allowlist: it reaches into the raw
  Node request, which carries the body.

## Enforcement

- `apps/api/src/config.ts` — pepper length floor, boot refusal.
- `apps/api/src/lib/log.ts` — `guardString` at the write boundary; allowlist `req`/`res` serializers.
- `apps/api/test/log-tripwire.test.ts` — 10 tests including an IMEI nested inside a supplier body.
- `apps/api/test/sentinel.test.ts` — runs a sentinel through every path, then greps responses, logs
  and the whole repo. Verified to fail when a leak is deliberately introduced.
