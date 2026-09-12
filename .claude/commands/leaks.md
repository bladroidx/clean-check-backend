---
description: Run the IMEI leak sweep and privacy audit — sentinel test, logs, columns, telemetry, secrets
argument-hint: [path or package to focus on — omit for the whole repo]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You verify that no raw IMEI and no secret survives anywhere durable. You verify by running the
sweep, never by reading the code and concluding.
</role>

<context>
Scope: **${ARGUMENTS:-the whole repo}**

Sentinel: `353104112345678` — Luhn-valid, never a real handset.
</context>

<rules>
1. A raw IMEI in a log line, a column, a metric label, a span attribute, a webhook payload or an
   OpenAPI example is a **blocker**.
2. A pepper, tenant salt or provider key in the repo, image, env dump or log is a **blocker**.
3. `SERVER_PEPPER` under 32 bytes, or a boot path that tolerates a missing one, is a **blocker**.
4. `saltedHash` used for a server-side key is a **blocker** — correct construction is HMAC.
5. Quote the GDPR article for every privacy blocker.
6. Never soften a finding to hit a date.
</rules>

<skills>
Follow `.claude/skills/imei-privacy/SKILL.md` — execute its 8 steps in order.
</skills>

<workflow>
```bash
npm run test:sentinel
rg -n -i 'imei' db/migrations/ | rg -v 'imei_hash|imei_masked|imei_hash_version'
rg -n 'saltedHash' packages apps
rg -n '\b\d{15}\b' packages apps db docs --glob '!**/fixtures/**' --glob '!testdata/**'
rg -n 'api[_-]?key|apiaccesskey|PEPPER|SALT|Bearer [A-Za-z0-9]{16,}|-----BEGIN' packages apps db docs
rg -n 'labels:|setAttribute\(|span\.' apps packages | rg -i 'imei|hash'
```
Then steps 6–8 of the skill: retention and partition drops, the full egress inventory, and the GDPR
posture (lawful basis, DPAs, transfers, DSAR).
</workflow>

<examples>
<example name="blocker-vs-finding">
BLOCKER — `providers/dhru/client.ts:88` logs `err.response.body`. Supplier bodies routinely echo the
full IMEI. GDPR Art. 5(1)(f), Art. 32.

FINDING — `routes/checks.ts:140` logs the tenant id at `info` per request. Noisy, not a leak.
</example>
</examples>

<format_constraints>
```
LEAK SWEEP — <sha>
BLOCKERS (n)
 1. <file:line> — <article> — <evidence> — <fix>
SENTINEL   logs <PASS|FAIL> · columns <PASS|FAIL> (<n> scanned) · files <PASS|FAIL>
HASHING    HMAC <ok> · pepper guard <ok|MISSING> · saltedHash sites <n> compat-only <y/n>
EGRESS     responses · webhooks · labels · openapi examples
GDPR       basis · DPAs <n>/<n> · transfers · DSAR
```
</format_constraints>

<final_instruction>
Run the sweep now and paste real output. Never report PASS for a step you did not run.
</final_instruction>
