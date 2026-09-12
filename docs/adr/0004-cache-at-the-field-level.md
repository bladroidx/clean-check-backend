# 0004 — Cache fields, not responses, with asymmetric TTLs

**Status:** Accepted · 2026-09-12
**Applies to:** `apps/api/src/cache` (M1), `cache_entries`

## Context

Cache-hit rate is essentially the gross margin of this business: an upstream lookup costs roughly
£0.30–1.20 and a cache hit costs nothing.

One GSX call returns `model`, `activation_lock`, `purchase_date` and `sold_by` — four facts whose
volatility differs by five orders of magnitude. A purchase date is immutable. An activation lock
flips the moment a seller signs out, which is literally what a buyer asks them to do while standing
in front of them.

## Decision

**Cache normalised fields, keyed `(imei_hash, capability, field)`, not provider responses.**

TTLs, each with both arguments — what it costs, and what staleness it admits:

| Field | TTL | Argument |
|---|---|---|
| `tac → model` | ∞, invalidated by import | a TAC allocation does not change |
| `purchase_date`, `sold_by` | ∞ | historical facts |
| `warranty.status` | **derived, never cached** | computed from `purchase_date` + policy |
| `lock.carrier` | 24 h | unlocks are user-initiated and propagate over hours |
| `blacklist` = `blocked` | 24 h | sticky; a stale block is a false alarm, which costs a sale |
| `blacklist` = `clean` | **60 min** | a stale clean is the one answer that causes real harm |
| `lock.activation` | **15 min** | flips the instant a seller signs out |

The cache is **global across tenants**: device reputation is a property of the device, not of who
asked.

Every cached answer sets `freshness.cached`, a true `age_seconds`, and the original `checked_at`.

## Alternatives rejected

**Cache the provider response blob.** Rejected: it forces one TTL across four volatilities, so it is
wrong three times. Either purchase dates get re-bought every hour, or activation locks go stale.

**Symmetric blacklist TTL.** Rejected: clean→blocked is the transition that hurts. Against the
inherent 24–72 h reporting lag, 60 minutes adds negligible staleness while keeping a re-check after
a haggle honest.

**Per-tenant cache.** Rejected: it would multiply provider spend by the number of tenants asking
about the same handset, for no gain in correctness.

## Consequences

- Deriving `warranty.status` from an immutable cached `purchase_date` turns a recurring paid lookup
  into a free calculation. This is the single largest saving in the design.
- **Accepted leak:** `age_seconds` reveals that *someone* checked this IMEI recently. It reveals
  nothing about who, and removing it would require lying about freshness — the one thing this
  product cannot do.
- `max_age_seconds: 0` must bypass the cache at full price, or the freshness promise is empty.

## Enforcement

- TTL table lives in one file with the argument in a comment beside each value.
- Adversarial tests cross every TTL boundary from both sides asserting `cached`, `age_seconds` and
  `checked_at` are truthful; see `/adversarial`.
