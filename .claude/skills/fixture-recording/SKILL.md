---
name: fixture-recording
description: Record, scrub, organise and replay provider fixtures for imei-check — capturing real supplier responses safely, removing IMEIs and credentials before they touch disk, structuring the 15-case matrix, and replaying with undici MockAgent. Use when adding a provider service, reproducing a supplier bug, or turning a production lexicon miss into a permanent regression case.
---

<role>
This skill is how supplier reality gets into the test suite without money, flakiness or an IMEI on
disk. Fixtures are the only honest record of what a supplier actually sends — everything else is
what we assumed they send.
</role>

<context>
```
packages/providers/test/fixtures/<provider>/<service_id>/<case>.json
{
  "recordedAt": "2026-09-12T20:14:03Z",
  "request":  { "action": "placeimeiorder", "serviceId": "30" },
  "response": { "httpStatus": 200, "contentType": "text/html; charset=utf-8",
                "body": "Model: iPhone 13 Pro<br>Blacklist Status: Clean<br>IMEI: 35••••••••••78" }
}
```
Replay is `undici` `MockAgent`, so no test can reach the network.
</context>

<rules>
1. **Scrub on write, never on read.** The recorder rewrites IMEIs to the masked form and strips
   credentials *before* the file is created. A scrub-on-read fixture has already leaked.
2. **`--record` never runs in CI.** It is gated on an env var and a live key, and CI has neither.
3. **Never hand-write a fixture.** A hand-written fixture encodes your idea of the supplier, which
   is precisely what is wrong when the parser breaks.
4. **One case per file, named for the condition**, not the expectation: `unrecognised-status.json`,
   not `should-be-inconclusive.json`.
5. **Preserve the body byte-for-byte** apart from scrubbing — the BOM, the encoding lie and the
   stray whitespace are the bug.
6. **A production lexicon miss becomes a fixture** in the same change as the lexicon entry.
7. **Never commit a fixture containing a real IMEI, a key, a session cookie or a customer's data.**
   The pre-commit scan is a backstop, not the control.
</rules>

<workflow>
1. **Choose the case** from the 15-case matrix. Check it does not already exist.
2. **Record** against a low-value service with a test IMEI where possible:
   `IMEI_RECORD=1 npm -w @imei-check/providers run record -- --provider sickw --service 30 --case clean`
3. **Verify the scrub** — grep the new file for `\d{14,16}`, for the key prefix, and for `Set-Cookie`.
4. **Commit the fixture with the test that consumes it**, never alone.
5. **For a hostile case you cannot provoke** (a WAF page, a truncated body), capture it from a real
   incident's `provider_call_bodies` row rather than inventing it. If it has never happened, do not
   invent it — write the case when it does.
6. `npm test -- providers` and paste real output.
</workflow>

<examples>
<example name="replay-setup">
```ts
const agent = new MockAgent({ connections: 1 });
setGlobalDispatcher(agent);
agent.disableNetConnect();                 // any unmocked call fails the test, loudly

const fx = loadFixture('sickw', '30', 'waf-html-200');
agent.get('https://sickw.com').intercept({ path: '/api/index.php', method: 'POST' })
     .reply(fx.response.httpStatus, fx.response.body,
            { headers: { 'content-type': fx.response.contentType } });
```
`disableNetConnect()` is the important line: it turns "this test accidentally hit the real API and
cost us money" from a possibility into a failure.
</example>

<example name="the-scrubber">
```ts
const scrub = (body: string) => body
  .replace(/\b\d{15}\b/g, (m) => mask(m))            // IMEIs → 35•••••••••••78
  .replace(/\b\d{14}\b/g, '[REDACTED-14]')            // partial / MEID-shaped
  .replace(/(apiaccesskey=)[^&\s"]+/gi, '$1[REDACTED]')
  .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1[REDACTED]');
```
Run it before `writeFileSync`, and assert in the recorder's own test that a body containing a
sentinel IMEI comes out masked.
</example>
</examples>

<format_constraints>
```
FIXTURES — <provider>/<service>
 ADDED    <case> — <what it reproduces> — source: <live record|incident row>
 SCRUB    imei <clean> · keys <clean> · cookies <clean>
 MATRIX   <n>/15 — MISSING <cases>
 REPLAY   disableNetConnect <on> · tests <n> consuming
```
</format_constraints>
