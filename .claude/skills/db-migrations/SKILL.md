---
name: db-migrations
description: Author and apply Postgres schema changes in imei-check with dbmate — expand/contract sequencing, lock classification, CONCURRENTLY index builds, range partitioning for checks and provider_calls, retention by partition drop, and the append-only ledger invariants. Use for any migration, new table or column, or index change.
---

<role>
This skill is how a schema change reaches a live database without taking a lock that stalls the API.
</role>

<context>
Plain SQL in `db/migrations/NNNN_name.sql`, applied by dbmate as a **separate init step**, never on
app boot — N replicas racing dbmate is a bad afternoon.

`checks` and `provider_calls` are `PARTITION BY RANGE` on their timestamps, so retention is a
partition drop rather than a `DELETE` that bloats and locks.

`credit_ledger` is append-only truth; `credit_accounts.balance` is a same-transaction cache.
</context>

<rules>
1. **No raw-IMEI column, ever.** `imei_hash` and `imei_masked` only.
2. **Expand/contract, always**: add nullable → backfill → write both → read new → drop old, across
   separate releases. A rename in one migration is a blocker.
3. **Classify the lock for every statement** and state it in the migration header comment.
4. **`CREATE INDEX CONCURRENTLY` needs `-- migrate:up transaction:false`**, and a check for a left
   behind `INVALID` index if it fails halfway.
5. **`ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT`** — never a blocking validation on a
   hot table.
6. **A new partitioned table ships with its retention job** in the same change.
7. **Every migration has a tested `down`**, or a comment saying why it is irreversible.
8. **`jsonb` needs a reason.** Evidence and coverage are genuinely schemaless; a status enum is not.
9. **Backfills are batched and resumable**, never one statement over a partitioned table.
</rules>

<workflow>
1. `npx dbmate new <name>`; read the last three migrations to match style.
2. Classify: additive · expand · contract · index · partition · backfill.
3. Write `-- migrate:up` / `-- migrate:down`, with a header comment naming the lock per statement.
4. Apply to a scratch DB; `npx dbmate status`; then re-apply from empty to prove ordering.
5. `EXPLAIN (ANALYZE, BUFFERS)` the queries the change serves; paste real before/after.
6. Run the integration suite including the ledger concurrency test.
</workflow>

<examples>
<example name="lock-table">
| Statement | Lock | Safe on a hot table? |
|---|---|---|
| `ADD COLUMN` nullable, no default | `ACCESS EXCLUSIVE`, instant | yes |
| `ADD COLUMN` with a **volatile** default | rewrites the table | **no** |
| `ADD COLUMN` with a constant default (PG 11+) | metadata only | yes |
| `CREATE INDEX` | `SHARE` — blocks writes for the build | **no** |
| `CREATE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` | yes |
| `ADD CONSTRAINT` (validating) | `ACCESS EXCLUSIVE` for a full scan | **no** |
| `ADD CONSTRAINT ... NOT VALID` | brief `ACCESS EXCLUSIVE` | yes |
| `ALTER COLUMN TYPE` | rewrites | **no** — expand/contract instead |
| `DROP COLUMN` | metadata only | yes, but only after contract phase |
</example>

<example name="a-correct-index-migration">
```sql
-- migrate:up transaction:false
-- Lock: SHARE UPDATE EXCLUSIVE — reads and writes continue during the build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_provider_calls_tenant_started
  ON provider_calls (tenant_id, started_at DESC);

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS idx_provider_calls_tenant_started;
```
Check for a failed build before retrying:
```sql
SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid;
```
</example>

<example name="append-only-enforced-not-assumed">
```sql
CREATE OR REPLACE FUNCTION credit_ledger_is_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'credit_ledger is append-only (attempted %)', TG_OP; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_ledger_no_mutation
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_is_append_only();
```
A convention that only a reviewer enforces is not an accounting control.
</example>
</examples>

<format_constraints>
```
MIGRATION — <file>
 CLASS      <additive|expand|contract|index|partition|backfill>
 LOCKS      <statement> → <mode> — est <duration> on <rows>
 DOWN       tested | irreversible: <reason>
 PLANS      <query> — before <cost/ms> → after <cost/ms>
 INVARIANTS append-only <ok|MISSING> · SUM(delta)=balance <test path>
 RETENTION  <table> — drop job <path|MISSING>
```
</format_constraints>
