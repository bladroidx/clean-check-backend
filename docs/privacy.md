# Privacy

What this service stores about an IMEI, who can read it back, who else sees it, and how to answer
a data-subject request. See [ADR-0003](adr/0003-no-raw-imei-at-rest.md) and
[ADR-0007](adr/0007-encrypted-imei-at-rest.md) for the design reasoning; this page is the
operational summary.

## What is stored

| Column | Content | Purpose |
|---|---|---|
| `checks.imei_hash` | `HMAC-SHA256(SERVER_PEPPER, digits)` | Internal cache/dedupe/abuse key. Never returned to any caller. |
| `subject.imei_hash` (on the wire) | `HMAC-SHA256(tenant_salt, digits)` | Lets the one seeded tenant correlate its own records — and only its own, since the salt is per-tenant. Never used as a server-side lookup key. |
| `checks.imei_masked` | e.g. `35•••••••••••78` | The only human-readable form of the IMEI that ever leaves the process on an ordinary response. |
| `checks.imei_encrypted` / `checks.imei_key_version` | `nonce(12) ‖ AES-256-GCM ciphertext ‖ tag(16)`, AAD = check id | ADR-0007: the raw IMEI, encrypted, for the retention window — added because the operator needed to answer "which phone was this?" after the fact, which a hash cannot do. `NULL` on checks written before ADR-0007 shipped. |
| `imei_reveals` | `id, check_id, actor, reason, revealed_at` (append-only, trigger-enforced) | Audit trail of every decryption. `reason` is scrubbed of IMEI-shaped digit runs (14+ digits) before it is stored, so typing the device number into the reason field does not itself become a second, unaudited copy of it. |

No raw IMEI is ever written to a log line, a metric label, a span attribute, an error message, or
an OpenAPI example, at any of these steps — enforced by the log write-boundary guard
(`apps/api/src/lib/log.ts`) and swept for by `apps/api/test/sentinel.test.ts`.

## Who can decrypt

Exactly one code path: `revealImei` in `packages/core/src/crypto/reveal.ts`. It writes the
`imei_reveals` audit row **before** decrypting, and does not swallow that write's failure — the
implementation is sequential, not transactional, so a database that rejects the audit insert means
nothing is ever decrypted.

Two entry points to that one path:

1. `POST /v1/admin/checks/:id/imei/reveal` — requires the `imei:reveal` scope. A key holding both
   `imei:reveal` and `checks:write` is refused outright at auth: the service key
   (check-this-phone's backend) can never reach this route. Rate-limited to 10/minute per key.
   Response is `Cache-Control: no-store` and excluded from request logging.
2. `npm run imei:reveal -- <check_id> --reason "..."` — the same code path, run from a host holding
   `DATABASE_URL` and `IMEI_ENCRYPTION_KEYS` directly. Recorded in `imei_reveals` with
   `actor: 'cli'`.

Losing `IMEI_ENCRYPTION_KEYS` makes every stored IMEI permanently unrecoverable; hashes, masked
values and past reports are unaffected.

## Processors

| Processor | What they receive | Status |
|---|---|---|
| **imei24** (`pro.imei24.com`) | The raw IMEI digits and the service id being purchased — **no user or tenant identifier**. | **Release blocker.** No Data Processing Agreement is in place. Their jurisdiction is unknown, which leaves the third-country-transfer question (GDPR Ch. V) unanswered. This service must not go live with real IMEIs until one of those two is resolved. |

No other third party receives an IMEI in any form. Everything else imei24's response produces
(blacklist status, lock state, warranty text) is normalised through the lexicon before it is
stored or returned — see `packages/providers/src/normalise/`.

## Retention and erasure

- `checks.imei_encrypted` lives and dies with its `checks` partition; dropping the partition
  deletes the ciphertext along with everything else in it.
- `imei_reveals` is append-only (a database trigger refuses `UPDATE`/`DELETE`) and is never dropped
  early — it is the audit trail, not a cache.
- **DSAR erasure**, given a data subject's own IMEI (rehashed with `SERVER_PEPPER` to find the
  matching rows, never stored as an index the subject could look up themselves):

  ```sql
  UPDATE checks
     SET imei_encrypted = NULL, imei_key_version = NULL
   WHERE imei_hash = $1;
  ```

  This leaves `imei_hash` and `imei_masked` in place — they do not reverse to the device number —
  and removes the only column that does. `imei_reveals` rows referencing the check are not erased:
  they record that a decryption happened, not the IMEI itself, and are the compliance evidence for
  *this* erasure request should it ever be questioned.

## Open items

- imei24 DPA and jurisdiction (see Processors above) — release blocker.
- `IMEI_ENCRYPTION_KEYS` must live in the platform secret store, separate from database backups; a
  backup that includes both the ciphertext and the key defeats the separation ADR-0007 relies on.
