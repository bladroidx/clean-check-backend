---
name: imei-privacy
description: Verify that imei-check never stores, logs or leaks a raw IMEI and that its GDPR posture holds — the 8-step audit, hashing construction, the log tripwire, the sentinel test, retention and partition drops, DPAs and third-country transfers, and DSAR answerability. Use before any merge touching logging, persistence, providers or error paths, and before any release.
---

<role>
This skill is the audit that keeps "we never store or log a raw IMEI" true past month three. It is
a procedure with assertions, not a checklist to read and agree with.
</role>

<context>
An IMEI is personal data (GDPR Art. 4(1) — an identifier relating to an identifiable natural
person). The space is ~10^14 and enumerable in seconds, so an unsalted digest is not anonymous.

Two hashes:
- **Internal** `HMAC-SHA256(SERVER_PEPPER, digits)` — cache, dedupe, abuse. Never returned.
- **Returned** `HMAC-SHA256(tenant_salt, digits)` — a tenant correlates their own records only.
- `Imei.saltedHash` (`sha256("salt:digits")`) is a verbatim Kotlin port for golden-vector parity.
  **Compat only.**

We hold a keyed hash *and* a lookup log, and can answer "what do you hold on IMEI X" by
recomputing. That is **pseudonymised personal data, in scope** — not anonymous. Any document that
claims otherwise is wrong.
</context>

<rules>
1. Raw IMEI in a log line, at any level, in any environment — **blocker**. The likely vector is a
   supplier's free-text error message, not our own format strings.
2. Raw IMEI in any column, including `jsonb` evidence and `provider_call_bodies` — **blocker**.
3. Raw IMEI in a metric label, span attribute or span name — **blocker**.
4. Raw IMEI in an outbound webhook or any response field but `imei_masked` — **blocker**.
5. A pepper or tenant salt in the image, repo, env dump or log — **blocker**.
6. `SERVER_PEPPER` under 32 bytes, or a boot path tolerating a missing one — **blocker**.
7. `saltedHash` used for a server-side key — **blocker**; correct construction is HMAC.
8. Retention exceeded (`checks` 180 d · `provider_calls` 400 d · `provider_call_bodies` 7 d), or
   implemented as `DELETE` instead of a partition drop — **blocker**.
9. Assert against serialised output, never the type. Verify by running the sentinel test, never by
   reading the code and concluding.
</rules>

<workflow>
**1. Config and pepper guard.**
```bash
rg -n 'SERVER_PEPPER|TENANT_SALT|IMEI_PEPPER' --glob '!**/node_modules/**' -g '!*.md' .
```
Confirm the zod config schema enforces `.min(32)` and that boot fails, with a test proving it.

**2. Hash construction.**
```bash
rg -n 'saltedHash|createHash\(.sha256|createHmac' packages apps
```
Every `saltedHash` call site must be test-only or explicitly marked compat. Server keys use `hmac`.

**3. Log tripwire.** Confirm the pino serializer hook scans emitted strings for `\d{14,16}` and
**throws in dev/test**, redacts in prod. A `redact:` path list alone is a finding — the risk is an
IMEI inside someone else's free text, which no path list can name.

**4. Schema grep.**
```bash
rg -n -i 'imei' db/migrations/ | rg -v 'imei_hash|imei_masked|imei_hash_version'
```
Any hit is a blocker at the schema level, before any code writes to it.

**5. Sentinel test.** The control. See the example below. Must run in CI and must not be skippable.

**6. Retention.** Confirm each table's policy, that it is a partition drop, and that the drop job
exists and ran recently. A partition scheme with no drop job is a disk incident with a delay fuse.

**7. Egress inventory.** Enumerate everything that leaves: response fields, outbound webhooks,
metric labels, span attributes, error bodies, the OpenAPI examples. Check each against rules 1–4.
OpenAPI examples are a real leak route — a real IMEI pasted into a sample response is published.

**8. GDPR posture.** Lawful basis stated and documented (legitimate interest + a written LIA for
fraud prevention); a DPA with **every** provider; a transfer mechanism for third countries (these
suppliers are largely outside the EEA); retention limits published; DSAR answerable by recomputing
the hash. Quote the article for every finding.
</workflow>

<examples>
<example name="the-sentinel-test">
```ts
const SENTINEL = '353104112345678';   // Luhn-valid, never a real handset

it('no raw IMEI survives a full check, anywhere', async () => {
  const logs = captureLogs();
  await runFullCheck(SENTINEL);                       // every capability, incl. failure paths

  expect(logs.raw()).not.toContain(SENTINEL);

  for (const { table, column } of await allTextAndJsonbColumns(db)) {
    const { rows } = await db.query(
      `SELECT 1 FROM ${table} WHERE ${column}::text LIKE $1 LIMIT 1`, [`%${SENTINEL}%`]);
    expect(rows, `${table}.${column} contains the sentinel IMEI`).toHaveLength(0);
  }

  expect(await grepFilesWritten(SENTINEL)).toHaveLength(0);
});
```
`allTextAndJsonbColumns` reads `information_schema` at runtime rather than a hardcoded list — a new
column added next month is covered automatically, which is the whole point. This is the direct
analogue of the app's `ProbeContractTest`.
</example>

<example name="the-tripwire-that-is-a-control">
```ts
const IMEI_SHAPED = /\d{14,16}/;
const guard = (s: string) => {
  if (!IMEI_SHAPED.test(s)) return s;
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('IMEI-shaped digits reached the logger — redact at the call site');
  }
  return s.replace(/\d{14,16}/g, '[REDACTED-IMEI]');
};
```
Throwing in dev and test is what makes it a control. Redacting everywhere would hide the bug and
train people to rely on the net.
</example>

<example name="blocker-vs-finding">
BLOCKER — `providers/dhru/client.ts:88` logs `err.response.body` on parse failure. Supplier bodies
routinely echo the full IMEI. GDPR Art. 5(1)(f), Art. 32.

FINDING — `routes/checks.ts:140` logs the tenant id at `info` on every request. Noisy, not a leak.
</example>
</examples>

<format_constraints>
```
PRIVACY AUDIT — <sha>
BLOCKERS (n)
 1. <file:line> — <GDPR article> — <evidence> — <fix>
SENTINEL   logs <PASS|FAIL> · columns <PASS|FAIL> (<n> scanned) · files <PASS|FAIL>
HASHING    internal HMAC <ok> · pepper guard <ok|MISSING> · saltedHash sites <n>, compat-only <y/n>
RETENTION  <table> — <n>d policy / <n>d actual / <partition drop|DELETE|NONE>
EGRESS     responses <ok> · webhooks <ok> · labels <ok> · openapi examples <ok|REAL IMEI FOUND>
GDPR       basis <where> · DPAs <n>/<n> · transfers <mechanism|MISSING> · DSAR <answerable|NO>
```
</format_constraints>
