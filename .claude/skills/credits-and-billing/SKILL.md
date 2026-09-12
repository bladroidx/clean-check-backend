---
name: credits-and-billing
description: Implement and audit the money path in imei-check — the append-only credit ledger, two-phase reserve/settle, the charge matrix for every outcome, provider cost accounting written before the call, nightly reconciliation, and cache-hit rate as gross margin. Use when touching billing, pricing, credits, or when provider spend and revenue diverge.
---

<role>
This skill is the accounting contract. It exists because the two ways this business dies quietly are
charging for answers we did not give, and paying for calls we did not record.
</role>

<context>
Cost basis ≈ £0.30–1.20 per upstream lookup. Cached hits bill at 20% of list — not free (we did work
and carry the liability), not full (we would be charging for nothing).

`credit_ledger` is append-only truth. `credit_accounts.balance` is a cache written in the same
transaction and asserted nightly.

Two-phase: **reserve** an estimate at check creation, **settle** actuals at completion, release the
remainder. Without it, a ten-minute async order completing after the balance hits zero has no
defined behaviour.
</context>

<rules>
1. **Never charge for `unavailable`.**
2. **Never charge for `inconclusive(unrecognised_provider_value)`** — our bug, not their usage.
   Charging for it also removes the incentive to fix lexicon misses, which is the failure the whole
   design guards against.
3. **A failover attempt is absorbed, never charged.** Alert when `absorbed / revenue > 15%`.
4. **`provider_calls` is written before the HTTP call**, status `in_flight`, updated after.
5. **Reserved credits are released** on completion, rejection, and the hard 24 h async expiry.
6. **`SUM(delta) = balance` per tenant, asserted nightly, pages on drift.**
7. **Insufficient balance degrades, it does not 402.** Run what they can afford; return the rest as
   `unavailable(insufficient_credits, remedy: top_up_credits)`. Honour the four-arm contract even
   for billing — a 402 that kills the whole check throws away answers we could have given.
8. **`warranty.status` is derived from an immutable cached `purchase_date`**, never re-looked-up.
9. **The caller never sees our provider cost.**
</rules>

<workflow>
1. **Reserve** inside the check-creation transaction: `INSERT` a negative-delta ledger row tagged
   `reserved`, bump `reserved_credits`, check `balance - reserved >= 0` under `FOR UPDATE`.
2. **Call the provider**, having written the `provider_calls` row first.
3. **Settle**: append the actual charge, release the reservation remainder, update `balance`, all in
   one transaction keyed by `check_id` so a retry is idempotent.
4. **On expiry or rejection**, release fully and record why.
5. **Reconcile nightly** against the provider's `accountinfo` credit delta; explain any delta > 1%.
6. **Report unit economics per capability**, never in aggregate — one capability can subsidise a
   loss-making one indefinitely and the total looks fine.
</workflow>

<examples>
<example name="the-charge-matrix">
| Outcome | Cached | Failover attempt | Charge |
|---|---|---|---|
| `pass` / `fail` | no | — | full list |
| `pass` / `fail` | yes | — | 20% of list |
| `inconclusive(device_not_found_in_registry)` | no | — | full list — the provider answered |
| `inconclusive(unrecognised_provider_value)` | no | — | **zero** — our bug |
| `inconclusive(awaiting_provider)` | no | — | reserved, not settled |
| `unavailable(*)` | — | — | **zero** |
| any | — | yes | absorbed on the failover leg |
</example>

<example name="reserve-settle">
```ts
await db.transaction(async (tx) => {
  const acct = await tx.selectFrom('credit_accounts').where('tenant_id','=',t)
                       .forUpdate().executeTakeFirstOrThrow();
  if (acct.balance_credits - acct.reserved_credits < estimate) throw new InsufficientCredits(...);
  await tx.insertInto('credit_ledger').values({
    tenant_id: t, delta: -estimate, reason: 'reserve', check_id: id,
    balance_after: acct.balance_credits, idempotency_key: `${id}:reserve`,
  }).onConflict((c) => c.column('idempotency_key').doNothing()).execute();
  await tx.updateTable('credit_accounts')
          .set({ reserved_credits: acct.reserved_credits + estimate }).execute();
});
```
The `idempotency_key` unique constraint is what makes a retried reserve a no-op instead of a
double charge. Do not rely on the caller not retrying.
</example>

<example name="the-invariant-query">
```sql
SELECT l.tenant_id, SUM(l.delta) AS ledger, a.balance_credits AS cached
FROM credit_ledger l JOIN credit_accounts a USING (tenant_id)
GROUP BY l.tenant_id, a.balance_credits
HAVING SUM(l.delta) <> a.balance_credits;
```
Any row is a page, not a ticket. A balance that can silently disagree with its ledger is not an
accounting system.
</example>
</examples>

<format_constraints>
```
BILLING — <scope>
 MATRIX     <n>/<n> combinations correct — VIOLATIONS <list>
 LEDGER     drift <n> tenants · append-only <enforced|CONVENTION ONLY>
 RESERVES   open <n> · leaked >24h <n>
 RECONCILE  ours $<n> vs provider $<n> — delta <%> <explained|UNEXPLAINED>
 ECONOMICS  <capability> — rev $<n> · cost $<n> · absorbed $<n> · hit-rate <%> · margin <%>
```
Never report margin in aggregate only.
</format_constraints>
