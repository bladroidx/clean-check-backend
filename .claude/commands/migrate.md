---
description: Author, classify and apply a Postgres migration safely
argument-hint: <description of the schema change>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You write schema changes that apply to a live database without taking a lock that stalls the API.
</role>

<context>
Change requested: **${ARGUMENTS:-(none given — ask what the schema change is)}**

dbmate, plain SQL in `db/migrations/NNNN_name.sql`, applied as a separate init step — never on app
boot.
</context>

<rules>
1. **No raw-IMEI column, ever.** `imei_hash` / `imei_masked` only.
2. **Expand/contract, always.** A rename or a drop in one migration is a blocker.
3. **Classify the lock for every statement** in a header comment.
4. **`CREATE INDEX CONCURRENTLY` needs `-- migrate:up transaction:false`**, and a check for a left
   behind `INVALID` index.
5. **`ADD CONSTRAINT ... NOT VALID` then `VALIDATE`** — never a blocking validation on a hot table.
6. **A new partitioned table ships with its retention job.**
7. **Every migration has a tested `down`**, or a comment saying why it is irreversible.
</rules>

<skills>
Follow `.claude/skills/db-migrations/SKILL.md` — it owns the lock table and the partition patterns.
</skills>

<workflow>
```bash
npx dbmate new <name>
# write up/down, with a per-statement lock comment
npx dbmate up && npx dbmate status
npx dbmate down && npx dbmate up          # prove the down works
psql "$DATABASE_URL" -c "EXPLAIN (ANALYZE, BUFFERS) <the query this serves>"
npm run test:integration
```
</workflow>

<examples>
<example name="lock-classification">
`ADD COLUMN` nullable with no default → metadata only, safe. With a **volatile** default → full
rewrite, blocker on a hot table. `CREATE INDEX` without `CONCURRENTLY` → `ACCESS EXCLUSIVE` for the
whole build; on a 400-day partitioned `provider_calls` that is an outage.
</example>
<example name="the-tempting-shortcut">
"Add `imei` alongside `imei_hash` so support can look things up." Blocker. Support gets an endpoint
that hashes the input and queries by hash. That column would defeat the sentinel test, the
retention story and the GDPR posture in one line of SQL.
</example>
</examples>

<format_constraints>
```
MIGRATION — <file>
 CLASS     <additive|expand|contract|index|partition|backfill>
 LOCKS     <statement> → <mode> — est <duration> on <rows>
 DOWN      tested | irreversible: <reason>
 PLANS     <query> — before <cost/ms> → after <cost/ms>
 RETENTION <table> — drop job <path|MISSING>
```
</format_constraints>

<final_instruction>
If no change was described, ask what it is. Otherwise write the migration and show real output.
</final_instruction>
