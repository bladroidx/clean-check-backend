---
description: Bring the stack up locally and exercise the API end to end with real curls
argument-hint: [route or capability to focus on — omit for the full happy path]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

<role>
You prove the service actually works by running it and calling it, not by reading it.
</role>

<context>
Focus: **${ARGUMENTS:-the full free-tier and paid happy path}**

`docker compose` brings up postgres, api, worker and a **mock-provider** container, so the whole
thing is exercisable without spending a credit. Use an `imc_test_` key — it routes to
`MockProvider` and cannot spend money.
</context>

<rules>
1. **Never use an `imc_live_` key in a smoke run.** Test keys exist precisely so this is impossible
   to get wrong by accident.
2. **Paste real output**, including the failure cases. A smoke run that only shows the happy path
   has tested the least interesting third of the service.
3. **Check the four arms are reachable**, not just `pass`.
4. **Never smoke against a shared or production database.**
5. **Tear down** what you brought up.
</rules>

<workflow>
```bash
docker compose up -d --wait
npx dbmate up
curl -s localhost:3000/healthz
curl -s localhost:3000/readyz

# free tier — no key, no credits, no provider
curl -s -X POST localhost:3000/v1/imei/validate -H 'content-type: application/json' \
  -d '{"imei":"IMEI (slot 1): 353104112345678"}' | jq
curl -s localhost:3000/v1/tac/35310411 | jq

# paid path against the mock provider
curl -s -X POST localhost:3000/v1/checks \
  -H "authorization: Bearer $IMC_TEST_KEY" \
  -H 'idempotency-key: smoke-1' -H 'content-type: application/json' \
  -d '{"imei":"353104112345678","capabilities":["identity.model","blacklist.gsma"]}' | jq

# the arms that matter: force a provider failure and an unrecognised value
curl -s -X POST localhost:3000/v1/checks -H "authorization: Bearer $IMC_TEST_KEY" \
  -H 'idempotency-key: smoke-2' -H 'content-type: application/json' \
  -d '{"imei":"353104112345678","capabilities":["blacklist.gsma"],"_mock":"timeout"}' | jq
curl -s localhost:3000/openapi.json | jq '.info.version'
docker compose down
```
</workflow>

<examples>
<example name="what-to-check-in-the-output">
- `checked_at` is a real provider timestamp, not the serialisation moment
- `coverage.caveats` is present and non-empty on `blacklist`
- the timeout case is `unavailable`, HTTP **200**, and `credits_charged: 0`
- `summary.verdict` is `undetermined`, not `green`, when a section is unavailable
- `imei_masked` appears; the full 15 digits appear nowhere in the body or the logs
</example>
</examples>

<format_constraints>
```
SMOKE — <sha>
 UP        <services> · migrations <n> applied
 FREE      /v1/imei/validate <status> · /v1/tac <status>
 PAID      <capability> → <arm> · credits <n> · checked_at <source>
 ARMS SEEN pass <y/n> · fail <y/n> · inconclusive <y/n> · unavailable <y/n>
 LEAK      full IMEI in body/logs: <none|FOUND>
 DOWN      <clean|left running: why>
```
</format_constraints>

<final_instruction>
Bring it up, run the calls, paste real output including failures, then tear down.
</final_instruction>
