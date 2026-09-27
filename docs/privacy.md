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

The worker runs retention daily (`runRetention` in `packages/core/src/db/retention.ts`). Windows are
set by environment variable and bounded in code (`CHECKS_RETENTION_DAYS` 30–365,
`PROVIDER_CALLS_RETENTION_DAYS` 30–3650): the worker refuses to boot outside them, so a typo in
either direction ("18", "1800") cannot wipe live data or keep it for years.

| Data | Window | How it goes |
|---|---|---|
| `checks` — incl. `imei_encrypted`, the reversible IMEI | `CHECKS_RETENTION_DAYS`, default **180 days** (+ up to one day between runs) | Monthly UTC range partitions: a month wholly past the window is DETACHed and DROPped; the one month straddling the cutoff is trimmed by `DELETE`. |
| `check_sections` | same as `checks` | Deleted once the check they belong to is gone. |
| `provider_orders` (holds `imei_hash`) | same as `checks` | Deleted by age once settled; a pending order is abandoned by the poller at its `expires_at` first. |
| `idempotency_records` (holds the masked report) | same as `checks` | Deleted by age. |
| `cache_entries` (keyed by `HMAC(SERVER_PEPPER, imei)`) | its field's TTL (ADR-0004), **capped at 180 days** | Deleted once expired. The cap (`MAX_CACHE_SECONDS`) means even an "immutable" fact such as a model or purchase date no longer outlives the checks it came from. |
| `provider_calls`, `provider_balance_snapshots` — spend records, no IMEI | `PROVIDER_CALLS_RETENTION_DAYS`, default **400 days** | Same partition scheme as `checks`; snapshots deleted by age. A call row carries a `check_id`, which leads nowhere once the check is gone. |
| `imei_reveals` | kept for the life of the service | Append-only audit trail (actor, check id, scrubbed reason — no IMEI or hash). An audit trail that expires with the data it audits proves nothing. Revisit if a retention limit is required. |

The job keeps partitions ready two months ahead; a row that still lands in the DEFAULT partition
(the worker was down longer than that) is moved into its month, under a lock, when the partition is
created. `imei_job_last_success_timestamp_seconds{job="retention"}` on the worker's `/metrics`
shows when it last succeeded; it can fail (DETACH gives up after a 5 s lock wait rather than stall
the API behind a backup), so alert on it — see [alerts.md](alerts.md).

**Backups are not covered by any of the above.** A dropped partition lives on in every backup and
WAL archive taken before the drop. Backup retention must be set no longer than the checks window
(or documented separately), and `IMEI_ENCRYPTION_KEYS` must never be in the same backup.

### This is pseudonymised data, not anonymous data

Every column in the table at the top is personal data under GDPR (Art. 4(5), Recital 26): the
IMEI space is small enough to search. For one check row, `tac` (8 digits) plus the last two digits
of `imei_masked` leave about 10^5 candidate IMEIs, and hashing them against `subject_hash` with the
tenant salt from `tenants.imei_salt` — all in the same database — recovers the number in well under
a second. `imei_hash` reverses the same way for anyone who also holds `SERVER_PEPPER`. So a database
backup is sensitive on its own, not only in combination with the encryption keys, and the storage
decisions above are about limiting exposure, not about the data ceasing to identify a device.

### Erasure (DSAR)

Given a data subject's own IMEI, compute `h = HMAC-SHA256(SERVER_PEPPER, digits)` (never stored as
an index the subject could query themselves) and delete **every** row derived from it:

```sql
BEGIN;
DELETE FROM check_sections      WHERE check_id IN (SELECT id FROM checks WHERE imei_hash = $1);
DELETE FROM idempotency_records WHERE check_id IN (SELECT id FROM checks WHERE imei_hash = $1);
DELETE FROM provider_orders     WHERE imei_hash = $1;
DELETE FROM cache_entries       WHERE cache_key LIKE $1 || ':%';
DELETE FROM checks              WHERE imei_hash = $1;
COMMIT;
```

Rows written under an older `imei_hash_version` (none exist today) would need the older hash too.
`provider_calls` rows referring to those checks keep only spend data and a dangling `check_id`.
`imei_reveals` rows are kept: they record that a decryption happened, not the IMEI, and are the
evidence for *this* request should it be questioned. Backups taken before the erasure still contain
the rows until they age out.

## Open items

- imei24 DPA and jurisdiction (see Processors above) — release blocker.
- Confirm the retention windows above with whoever owns the privacy notice, and publish them there.
- Lawful basis for processing IMEIs is not stated here; record it (and a legitimate-interest
  assessment if that is the basis).
- Consider not storing `tac` + masked tail + tenant salt together (see "pseudonymised" above) —
  it would make a database backup far less useful to an attacker.
- The worker receives `SERVER_PEPPER` and `IMEI_ENCRYPTION_KEYS` through the shared compose env but
  never uses them; give it its own env block without them.
- `IMEI_ENCRYPTION_KEYS` must live in the platform secret store, separate from database backups; a
  backup that includes both the ciphertext and the key defeats the separation ADR-0007 relies on.
