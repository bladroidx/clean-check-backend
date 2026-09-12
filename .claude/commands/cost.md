---
description: Audit the money path — charge matrix, ledger integrity, reconciliation, margin per capability
argument-hint: [period, e.g. 30d — or a capability name]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You audit whether this service is making or losing money and whether its books match reality.
</role>

<context>
Scope: **${ARGUMENTS:-the last 30 days}**

Gross margin is essentially one number — cache-hit rate — and the fastest way to lose it is a
supplier raising a price nobody noticed.
</context>

<rules>
1. **Never charge for `unavailable`**, nor for `inconclusive(unrecognised_provider_value)`.
2. **Failover legs are absorbed.** Alert above 15% of revenue.
3. **`provider_calls` is written before the HTTP call** and reconciled nightly.
4. **`SUM(delta) = balance` per tenant** — any drift is a page, not a ticket.
5. **Reserved credits must be released** on completion, rejection and the 24 h expiry.
6. **Report margin per capability**, never in aggregate only.
</rules>

<skills>
Follow `.claude/skills/credits-and-billing/SKILL.md`.
</skills>

<workflow>
```sql
-- ledger integrity
SELECT l.tenant_id, SUM(l.delta) AS ledger, a.balance_credits AS cached
FROM credit_ledger l JOIN credit_accounts a USING (tenant_id)
GROUP BY l.tenant_id, a.balance_credits HAVING SUM(l.delta) <> a.balance_credits;

-- leaked reservations
SELECT check_id, created_at FROM credit_ledger
WHERE reason = 'reserve' AND created_at < now() - interval '24 hours'
  AND check_id NOT IN (SELECT check_id FROM credit_ledger WHERE reason = 'settle');

-- unit economics per capability
SELECT capability,
       SUM(credits_charged) AS revenue_credits,
       SUM(provider_cost_usd) FILTER (WHERE billable)     AS cost_billable,
       SUM(provider_cost_usd) FILTER (WHERE NOT billable) AS cost_absorbed,
       AVG((status = 'cache_hit')::int)                   AS hit_rate
FROM provider_calls WHERE started_at > now() - interval '30 days' GROUP BY capability;
```
Then reconcile against the provider's own `accountinfo` delta and check the catalogue drift job
actually ran.
</workflow>

<examples>
<example name="the-finding-that-pays-for-itself">
CRITICAL — margin negative on `lock.activation`. Catalogue records 2 credits / $0.11; live
`imeiservicelist` reports `CREDIT: 0.34`. The drift job last ran 19 days ago. 4,100 calls × 0.23
loss = £943. Fix: restore the job, alert on the job's own staleness, reprice.
</example>
</examples>

<format_constraints>
```
BILLING AUDIT — <period>
 MATRIX     <n>/<n> correct — VIOLATIONS <list>
 LEDGER     drift <n> tenants · append-only <enforced|CONVENTION ONLY>
 RESERVES   open <n> · leaked <n>
 RECONCILE  ours $<n> vs provider $<n> — delta <%>
 ECONOMICS  <capability> — rev · cost · absorbed · hit-rate · margin
 DRIFT      <n> changed · <n> auto-disabled · job last ran <when>
```
</format_constraints>

<final_instruction>
Run the queries now. Report margin per capability, never in aggregate only.
</final_instruction>
