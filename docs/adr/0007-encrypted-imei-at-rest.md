# 0007 — Encrypted IMEI at rest, revealable only by an audited admin action

**Status:** Accepted · 2026-09-25
**Amends:** ADR-0003 ("Raw IMEI never persists")

## Context

ADR-0003 stores only keyed hashes, so no stored check can be traced back to a device number.
The operator now needs to read back the IMEI of a past check (support, re-running a check out of
band, export). A hash cannot do that; reversible encryption can.

This raises the blast radius: a database dump **plus** the encryption key exposes every IMEI
checked within the retention window. The decision below keeps that pair apart and makes every
decryption deliberate and recorded.

## Decision

**ADR-0003 still holds for plaintext.** No raw IMEI in any column, log, metric, span, response
example or evidence blob. What changes: one column may hold the IMEI **encrypted**.

### Storage

- `checks.imei_encrypted bytea` — `nonce(12) ‖ AES-256-GCM ciphertext ‖ tag(16)`, fresh random
  nonce per row; associated data = `check_id`, so a ciphertext moved to another row fails to
  decrypt.
- `checks.imei_key_version int` — which key encrypted it; rotation re-encrypts in the background
  and old keys are removed once no row references them.
- `checks.imei_hash` is unchanged and remains the only lookup/cache/dedupe key. **Nothing ever
  decrypts in order to search.**
- One module owns it: `packages/core/src/crypto/imei-cipher.ts` (`encrypt`, `decrypt`). No other
  code imports `node:crypto` cipher functions for IMEIs (dependency-cruiser rule).

### Key

- `IMEI_ENCRYPTION_KEY` (32 bytes, base64), distinct from `SERVER_PEPPER`, held in the secret
  store — never in the database, never in the repo, never logged.
- The process refuses to boot if it is not exactly 32 bytes once `DATABASE_URL` is set.
- Keyring form for rotation: `IMEI_ENCRYPTION_KEYS=1:<b64>,2:<b64>`, current = highest version.

### Who can decrypt

`api_keys.scopes` (existing, unused column) becomes enforced:

| Scope | Allows |
|---|---|
| `checks:write` | `/v1/checks*`, `/v1/deep_checks*`, `/v1/capabilities`, free routes |
| `imei:reveal` | `POST /v1/admin/checks/:id/imei/reveal` only |

`checks:write` is the scope the seed scripts already mint; the service key's existing `imei:read`
grants nothing and never will. The service key (check-this-phone-backend) gets **403** on the
reveal route; the admin key holds only `imei:reveal` and gets 403 on everything else. A key
holding both `checks:write` and `imei:reveal` is refused at auth. New script
`npm run seed:admin-key` mints the admin key. No backfill is needed.

Two ways to reveal, one code path:

1. `POST /v1/admin/checks/:id/imei/reveal`, body `{ "reason": string (10–500 chars) }`.
   Response `{ check_id, imei }` with `Cache-Control: no-store`; response body excluded from
   logging; rate-limited to 10/min per key.
2. `npm run imei:reveal -- <check_id> --reason "..."` on a host with the key.

### Audit

`imei_reveals` (append-only, enforced by trigger): `id, check_id, actor ('api:<key_id>' | 'cli'),
reason, revealed_at`. The audit row is **written before decryption; if it cannot be written,
nothing is decrypted** — the implementation is sequential, not transactional: `revealImei`
(`packages/core/src/crypto/reveal.ts`) writes the audit row and lets that write's failure propagate
before it ever calls `cipher.decrypt`. `reason` is scrubbed of IMEI-shaped digit runs before it is
stored, so a caller who types the device number into the reason field does not undo ADR-0003.

### Retention

The ciphertext lives and dies with its `checks` partition; dropping the partition deletes it.
(Amended 2026-09-27: until then `checks` had only a DEFAULT partition and nothing dropped it, so
this sentence was not true. Monthly partitions and the worker's retention job —
`packages/core/src/db/retention.ts`, `CHECKS_RETENTION_DAYS`, default 180 — now make it so.)
DSAR erasure: null `imei_encrypted` for rows matching the hash.

## Alternatives rejected

- **Hash only (status quo).** Cannot answer "which phone was this?" — the stated need.
- **Reveal via the service key.** One leaked key would expose every stored IMEI.
- **CLI-only.** Rejected by the operator; the admin-scoped route plus audit is the compromise.
- **Database-level encryption (pgcrypto, TDE).** The key would sit next to the data or in SQL
  text/logs; application-level encryption keeps the key out of Postgres entirely.

## Consequences

- `docs/privacy.md` must say IMEIs are stored encrypted for the retention window, and why.
- The sentinel test changes: it must still find **no plaintext** sentinel digits anywhere in the
  DB, logs or responses (other than the reveal response), and must additionally prove the reveal
  route writes an audit row and is refused to a `checks:write` key.
- Losing `IMEI_ENCRYPTION_KEY` makes stored IMEIs unrecoverable (hashes and reports unaffected).
