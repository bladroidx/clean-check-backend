# 0005 — TAC data: Osmocom with attribution, no bulk endpoint, harvest our own

**Status:** Accepted · 2026-09-12
**Applies to:** `tac_entries`, `GET /v1/tac/:tac`, the TAC import job

## Context

The free tier needs a real TAC directory. The Android app currently ships a
`BundledTacDirectory` with three demo entries.

Two free sources exist, and the obvious reading of them is wrong:

- **Osmocom TAC DB** — CC BY-SA 3.0. Its site currently serves a mismatched TLS certificate
  (`fandango.binarybase.org`), which reads as neglect.
- **`MoazEb/tac-database`** — labelled **MIT**, ~255k rows, updated 2026-07-23.

MIT looks strictly better than CC BY-SA for a commercial API. It is not. That repository's own
README lists its Data Sources as *"Public IMEI databases · Osmocom TAC · Is this Phone Blocked? ·
Community contributions"* and then licenses the compilation MIT. You cannot relicense CC BY-SA
derived data as MIT, and neither can they.

## Decision

**Use Osmocom directly, attributed.** Using the MIT-labelled repackage would mean relying on a grant
the uploader had no right to make, and forfeiting the attribution defence we would otherwise have.

CC BY-SA 3.0's copyleft attaches to *adaptations you distribute*; it has no AGPL-style network
clause. Serving individual facts from a server-side query is not distributing an adaptation, and
individual facts are not copyrightable — what is protected is the selection and arrangement. So:

1. **Attribute in the response.** `coverage.attribution` on every offline `identity` section, plus
   `GET /v1/attributions`.
2. **No bulk export, no wildcard, no pagination, no listing.** `GET /v1/tac/:tac` serves one TAC and
   is hard rate-limited (60/min, 5k/day per key). An unlimited single-lookup endpoint is a bulk
   export with extra steps.
3. **Pin and checksum the fetch** rather than trusting that TLS certificate.
4. **Harvest our own.** Every paid provider response contains a model string for a known TAC — a
   `(TAC → model)` observation we own outright with no licence attached. Stored with
   `source = 'observed'`, `source_priority = 100`, above `paid` (50) and `osmocom` (10).

## Alternatives rejected

**`MoazEb/tac-database` because MIT is easier.** Rejected — see Context. This was my first
recommendation and it was wrong; the README is the evidence.

**A paid feed now** (GSMA Device Map, 51Degrees, DeviceAtlas, low four figures/yr). Deferred, not
rejected: it buys clean commercial rights and the freedom to serve in bulk. Budget it for when a
B2B customer wants to redistribute our output — and get an hour of a solicitor's time *before* that
customer signs.

## Consequences

- We carry an attribution string in every identity response forever. Cheap.
- We can never offer a bulk TAC export as a product without buying a commercial feed first.
- The observed-TAC table compounds: after a few thousand paid lookups it covers exactly the devices
  people actually check, which is a better distribution than a comprehensive one.
- **Residual risk:** a compiled dataset's licence declaration is not automatically sound. TAC data
  therefore lives in its own table with its own ingest, never mingled with proprietary tables, so it
  can be swapped or purged cleanly if provenance is ever challenged.

## Enforcement

- `apps/api/test/routes.test.ts` — "offers no bulk or wildcard listing".
- Attribution asserted in the TAC and validate route tests.
- Import job validates row count within ±20% of the previous import: a truncated download reads
  downstream as "unknown TAC", which is honest but is still a silent capability loss.
